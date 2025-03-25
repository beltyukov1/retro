package main

import (
	"encoding/json"
	"log"
	"net/http"
	"sort"
	"strings"
	"sync"

	"github.com/gorilla/websocket"
)

type Card struct {
	ID      string          `json:"id"`
	Text    string          `json:"text"`
	Column  string          `json:"column"`
	Author  string          `json:"author"`
	Color   string          `json:"color"`
	Likes   int             `json:"likes"`
	LikedBy map[string]bool `json:"-"` // Track users who liked this card
}

type RetroBoard struct {
	sync.RWMutex
	Cards           []Card
	UsedColors      map[string]bool
	HideContent     bool
	ActiveUserNames map[string]bool // map with lowercase usernames for case-insensitive comparison
}

type WSMessage struct {
	Type    string      `json:"type"`
	Payload interface{} `json:"payload"`
}

var board RetroBoard
var clients = make(map[*websocket.Conn]bool)
var clientsMutex sync.RWMutex
var clientUsernames = make(map[*websocket.Conn]string) // Map to track which connection belongs to which username
var clientColors = make(map[*websocket.Conn]string)    // Map to track which color belongs to which connection
var clientUsernamesMutex sync.RWMutex

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true // Allow all origins in development
	},
}

func main() {
	// Initialize the board
	board.UsedColors = make(map[string]bool)
	board.ActiveUserNames = make(map[string]bool)
	log.Println("Server starting with clean username registry")

	// Serve static files
	fs := http.FileServer(http.Dir("static"))
	http.Handle("/", fs)

	// API endpoints
	http.HandleFunc("/ws", handleWebSocket)

	log.Println("Server starting on http://localhost:8080")
	log.Fatal(http.ListenAndServe(":8080", nil))
}

func handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WebSocket upgrade failed: %v", err)
		return
	}
	defer conn.Close()

	// Register client
	clientsMutex.Lock()
	clients[conn] = true
	clientsMutex.Unlock()

	// Remove client on disconnect
	defer func() {
		clientsMutex.Lock()
		delete(clients, conn)
		clientsMutex.Unlock()

		// Clean up username and color when connection closes
		clientUsernamesMutex.Lock()
		username, exists := clientUsernames[conn]
		color, colorExists := clientColors[conn]

		if exists {
			log.Printf("Connection closed for user: %s", username)
			delete(clientUsernames, conn)

			// Remove from active usernames
			board.Lock()
			lowerUsername := strings.ToLower(username)
			delete(board.ActiveUserNames, lowerUsername)

			// Release the user's color if it exists
			if colorExists {
				delete(board.UsedColors, color)
				delete(clientColors, conn)
				// Broadcast that the color is now available
				go broadcastToClients(WSMessage{
					Type:    "colorReleased",
					Payload: color,
				})
				log.Printf("Released color %s for user %s", color, username)
			}

			log.Printf("Cleaned up username '%s' on disconnect. Active users now: %v", lowerUsername, board.ActiveUserNames)
			board.Unlock()
		}
		clientUsernamesMutex.Unlock()
	}()

	// Send initial board state immediately
	initialState := getBoardState("") // Use empty username for initial state
	if err := conn.WriteJSON(initialState); err != nil {
		log.Printf("Error sending initial state: %v", err)
		return
	}

	// Handle incoming messages
	for {
		var msg WSMessage
		err := conn.ReadJSON(&msg)
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				log.Printf("WebSocket read error: %v", err)
			}
			break
		}

		switch msg.Type {
		case "addCard":
			// Convert payload to Card
			payloadBytes, err := json.Marshal(msg.Payload)
			if err != nil {
				log.Printf("Error marshaling card payload: %v", err)
				continue
			}
			var card Card
			if err := json.Unmarshal(payloadBytes, &card); err != nil {
				log.Printf("Error unmarshaling card: %v", err)
				continue
			}

			// Initialize the LikedBy map
			card.LikedBy = make(map[string]bool)

			board.Lock()
			board.Cards = append(board.Cards, card)
			board.Unlock()

			// Broadcast the new card to all clients
			broadcastToClients(WSMessage{
				Type:    "cardAdded",
				Payload: card,
			})

		case "deleteCard":
			// Extract payload as a structure with cardID and authorName
			payloadBytes, err := json.Marshal(msg.Payload)
			if err != nil {
				log.Printf("Error marshaling delete payload: %v", err)
				continue
			}
			var deleteData struct {
				ID         string `json:"id"`
				AuthorName string `json:"authorName"`
			}
			if err := json.Unmarshal(payloadBytes, &deleteData); err != nil {
				log.Printf("Error unmarshaling delete data: %v", err)
				continue
			}

			board.Lock()
			for i, card := range board.Cards {
				if card.ID == deleteData.ID {
					// Only allow deletion if the author matches
					if card.Author == deleteData.AuthorName {
						// Remove the card by swapping with the last element and truncating
						board.Cards[i] = board.Cards[len(board.Cards)-1]
						board.Cards = board.Cards[:len(board.Cards)-1]

						// Broadcast the deletion to all clients
						broadcastToClients(WSMessage{
							Type:    "cardDeleted",
							Payload: deleteData.ID,
						})
					} else {
						// Send error message back to the specific client
						conn.WriteJSON(WSMessage{
							Type:    "error",
							Payload: "You can only delete your own cards",
						})
					}
					break
				}
			}
			board.Unlock()

		case "moveCard":
			// Convert payload to move data
			payloadBytes, err := json.Marshal(msg.Payload)
			if err != nil {
				log.Printf("Error marshaling move payload: %v", err)
				continue
			}
			var moveData struct {
				ID        string `json:"id"`
				NewColumn string `json:"newColumn"`
			}
			if err := json.Unmarshal(payloadBytes, &moveData); err != nil {
				log.Printf("Error unmarshaling move data: %v", err)
				continue
			}

			board.Lock()
			// Find and update the card's column
			for i, card := range board.Cards {
				if card.ID == moveData.ID {
					board.Cards[i].Column = moveData.NewColumn
					// Broadcast the update to all clients
					broadcastToClients(WSMessage{
						Type: "cardMoved",
						Payload: struct {
							ID        string `json:"id"`
							NewColumn string `json:"newColumn"`
						}{
							ID:        moveData.ID,
							NewColumn: moveData.NewColumn,
						},
					})
					break
				}
			}
			board.Unlock()

		case "join":
			// Extract color and username from the payload structure
			payloadBytes, err := json.Marshal(msg.Payload)
			if err != nil {
				log.Printf("Error marshaling join payload: %v", err)
				continue
			}
			var joinData struct {
				Color    string `json:"color"`
				Username string `json:"username"`
			}
			if err := json.Unmarshal(payloadBytes, &joinData); err != nil {
				log.Printf("Error unmarshaling join data: %v", err)
				continue
			}

			if joinData.Color == "" {
				log.Printf("No color provided in join message")
				continue
			}

			if joinData.Username == "" {
				log.Printf("No username provided in join message")
				continue
			}

			// Check if username is already taken (case-insensitive)
			lowerUsername := strings.ToLower(joinData.Username)
			board.Lock()
			if _, exists := board.ActiveUserNames[lowerUsername]; exists {
				// Username is already in use
				board.Unlock()
				conn.WriteJSON(WSMessage{
					Type:    "error",
					Payload: "This username is already in use. Please choose another one.",
				})
				continue
			}

			// Check if color is already in use
			if board.UsedColors[joinData.Color] {
				// Color is already in use
				board.Unlock()
				conn.WriteJSON(WSMessage{
					Type:    "error",
					Payload: "This color is already in use. Please choose another one.",
				})
				continue
			}

			// Register username and color
			board.ActiveUserNames[lowerUsername] = true
			board.UsedColors[joinData.Color] = true
			board.Unlock()

			// Store username for this connection
			clientUsernamesMutex.Lock()
			clientUsernames[conn] = joinData.Username
			// Store color for this connection
			clientColors[conn] = joinData.Color
			clientUsernamesMutex.Unlock()

			// Notify all clients that a color is now in use
			broadcastToClients(WSMessage{
				Type:    "colorUsed",
				Payload: joinData.Color,
			})

			// Send the join success message
			conn.WriteJSON(WSMessage{
				Type:    "joinSuccess",
				Payload: nil,
			})

			// Send personalized board state with userLiked status
			conn.WriteJSON(getBoardState(joinData.Username))

		case "logout":
			// Extract color and username from the payload structure
			payloadBytes, err := json.Marshal(msg.Payload)
			if err != nil {
				log.Printf("Error marshaling logout payload: %v", err)
				continue
			}
			var logoutData struct {
				Color    string `json:"color"`
				Username string `json:"username"`
			}
			if err := json.Unmarshal(payloadBytes, &logoutData); err != nil {
				log.Printf("Error unmarshaling logout data: %v", err)
				continue
			}

			if logoutData.Color == "" {
				log.Printf("No color provided in logout message")
				continue
			}

			board.Lock()
			delete(board.UsedColors, logoutData.Color)
			// Free up username when user logs out if one was provided
			if logoutData.Username != "" {
				lowerUsername := strings.ToLower(logoutData.Username)
				delete(board.ActiveUserNames, lowerUsername)
				log.Printf("User '%s' logged out, removed from active users. Active users now: %v", lowerUsername, board.ActiveUserNames)
			}
			board.Unlock()

			// Remove username association from this connection
			clientUsernamesMutex.Lock()
			delete(clientUsernames, conn)
			delete(clientColors, conn)
			clientUsernamesMutex.Unlock()

			// Broadcast the color release to all clients immediately
			broadcastToClients(WSMessage{
				Type:    "colorReleased",
				Payload: logoutData.Color,
			})

		case "toggleHideContent":
			hideContent, ok := msg.Payload.(bool)
			if !ok {
				log.Printf("Invalid hide content format")
				continue
			}

			board.Lock()
			board.HideContent = hideContent
			board.Unlock()

			// Broadcast the toggle state to all clients
			broadcastToClients(WSMessage{
				Type:    "hideContentToggled",
				Payload: hideContent,
			})

		case "sortCards":
			// Extract payload for sort data
			payloadBytes, err := json.Marshal(msg.Payload)
			if err != nil {
				log.Printf("Error marshaling sort payload: %v", err)
				continue
			}
			var sortData struct {
				SortOrder string `json:"sortOrder"`
			}
			if err := json.Unmarshal(payloadBytes, &sortData); err != nil {
				log.Printf("Error unmarshaling sort data: %v", err)
				continue
			}

			board.Lock()
			// Sort cards based on the requested order
			if sortData.SortOrder == "asc" {
				// Sort by author in ascending order
				sort.Slice(board.Cards, func(i, j int) bool {
					return board.Cards[i].Author < board.Cards[j].Author
				})
			} else if sortData.SortOrder == "desc" {
				// Sort by author in descending order
				sort.Slice(board.Cards, func(i, j int) bool {
					return board.Cards[i].Author > board.Cards[j].Author
				})
			} else {
				// Reset to original order (by ID/time added)
				sort.Slice(board.Cards, func(i, j int) bool {
					return board.Cards[i].ID < board.Cards[j].ID
				})
			}
			board.Unlock()

			// Send personalized sorted cards to each client
			clientsMutex.RLock()
			for client := range clients {
				// Get username for this client
				clientUsernamesMutex.RLock()
				username, exists := clientUsernames[client]
				clientUsernamesMutex.RUnlock()

				// Create personalized card list with userLiked status
				board.RLock()
				personalizedCards := make([]map[string]interface{}, len(board.Cards))
				for i, card := range board.Cards {
					personalizedCard := map[string]interface{}{
						"id":     card.ID,
						"text":   card.Text,
						"column": card.Column,
						"author": card.Author,
						"color":  card.Color,
						"likes":  card.Likes,
					}

					// Add userLiked status for authenticated users
					if exists && card.LikedBy != nil {
						personalizedCard["userLiked"] = card.LikedBy[username]
					}

					personalizedCards[i] = personalizedCard
				}
				board.RUnlock()

				// Send personalized response to the client
				client.WriteJSON(WSMessage{
					Type:    "cardsSorted",
					Payload: personalizedCards,
				})
			}
			clientsMutex.RUnlock()

		case "likeCard":
			// Extract payload for like data
			payloadBytes, err := json.Marshal(msg.Payload)
			if err != nil {
				log.Printf("Error marshaling like payload: %v", err)
				continue
			}
			var likeData struct {
				CardId string `json:"cardId"`
				Liked  bool   `json:"liked"`
			}
			if err := json.Unmarshal(payloadBytes, &likeData); err != nil {
				log.Printf("Error unmarshaling like data: %v", err)
				continue
			}

			// Get the username for this connection
			clientUsernamesMutex.RLock()
			username, exists := clientUsernames[conn]
			clientUsernamesMutex.RUnlock()

			if !exists {
				conn.WriteJSON(WSMessage{
					Type:    "error",
					Payload: "You must be logged in to like cards",
				})
				continue
			}

			board.Lock()
			for i, card := range board.Cards {
				if card.ID == likeData.CardId {
					// Initialize LikedBy map if it doesn't exist
					if board.Cards[i].LikedBy == nil {
						board.Cards[i].LikedBy = make(map[string]bool)
					}

					if likeData.Liked {
						// Add like
						if !board.Cards[i].LikedBy[username] {
							board.Cards[i].LikedBy[username] = true
							board.Cards[i].Likes++
						}
					} else {
						// Remove like
						if board.Cards[i].LikedBy[username] {
							delete(board.Cards[i].LikedBy, username)
							board.Cards[i].Likes--
						}
					}

					// Broadcast the updated likes to all clients
					broadcastToClients(WSMessage{
						Type: "cardLiked",
						Payload: map[string]interface{}{
							"cardId":    likeData.CardId,
							"likeCount": board.Cards[i].Likes,
						},
					})

					// Send personalized response to the user who liked/unliked
					conn.WriteJSON(WSMessage{
						Type: "cardLiked",
						Payload: map[string]interface{}{
							"cardId":    likeData.CardId,
							"likeCount": board.Cards[i].Likes,
							"liked":     likeData.Liked,
						},
					})
					break
				}
			}
			board.Unlock()

		case "ping":
			// Simple ping-pong to keep the connection alive
			// No need to broadcast or modify state
			conn.WriteJSON(WSMessage{
				Type:    "pong",
				Payload: nil,
			})
		}
	}
}

func broadcastToClients(msg WSMessage) {
	clientsMutex.RLock()
	defer clientsMutex.RUnlock()

	for client := range clients {
		err := client.WriteJSON(msg)
		if err != nil {
			log.Printf("Error broadcasting to client: %v", err)
			client.Close()
		}
	}
}

func getBoardState(username string) WSMessage {
	board.RLock()
	defer board.RUnlock()

	// Create a copy of the cards with userLiked status
	cardsWithLikeStatus := make([]map[string]interface{}, len(board.Cards))
	for i, card := range board.Cards {
		cardMap := map[string]interface{}{
			"id":     card.ID,
			"text":   card.Text,
			"column": card.Column,
			"author": card.Author,
			"color":  card.Color,
			"likes":  card.Likes,
		}

		// Add userLiked status if username is provided
		if username != "" && card.LikedBy != nil {
			cardMap["userLiked"] = card.LikedBy[username]
		}

		cardsWithLikeStatus[i] = cardMap
	}

	return WSMessage{
		Type: "boardState",
		Payload: map[string]interface{}{
			"cards":       cardsWithLikeStatus,
			"usedColors":  board.UsedColors,
			"hideContent": board.HideContent,
		},
	}
}

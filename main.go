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
	ID     string `json:"id"`
	Text   string `json:"text"`
	Column string `json:"column"`
	Author string `json:"author"`
	Color  string `json:"color"`
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
	http.HandleFunc("/api/cards", handleCards)
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

		// Clean up username when connection closes
		clientUsernamesMutex.Lock()
		username, exists := clientUsernames[conn]
		if exists {
			log.Printf("Connection closed for user: %s", username)
			delete(clientUsernames, conn)

			// Remove from active usernames
			board.Lock()
			lowerUsername := strings.ToLower(username)
			delete(board.ActiveUserNames, lowerUsername)
			log.Printf("Cleaned up username '%s' on disconnect. Active users now: %v", lowerUsername, board.ActiveUserNames)
			board.Unlock()
		}
		clientUsernamesMutex.Unlock()
	}()

	// Send initial board state immediately
	board.RLock()
	initialState := WSMessage{
		Type: "boardState",
		Payload: map[string]interface{}{
			"cards":       board.Cards,
			"usedColors":  board.UsedColors,
			"hideContent": board.HideContent,
		},
	}
	board.RUnlock()

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
			log.Printf("Current active usernames: %v", board.ActiveUserNames)
			if board.ActiveUserNames[lowerUsername] {
				// Username is taken, send error
				board.Unlock()
				log.Printf("Username '%s' already taken", lowerUsername)
				conn.WriteJSON(WSMessage{
					Type:    "error",
					Payload: "This display name is already in use. Please choose a different name.",
				})
				continue
			}

			// Username is available, register it
			board.ActiveUserNames[lowerUsername] = true
			log.Printf("Registered username '%s', active users now: %v", lowerUsername, board.ActiveUserNames)
			board.UsedColors[joinData.Color] = true
			board.Unlock()

			// Associate this username with the current connection
			clientUsernamesMutex.Lock()
			clientUsernames[conn] = joinData.Username
			clientUsernamesMutex.Unlock()

			// Broadcast the color selection to all clients
			broadcastToClients(WSMessage{
				Type:    "colorUsed",
				Payload: joinData.Color,
			})

			// Send success message
			conn.WriteJSON(WSMessage{
				Type:    "joinSuccess",
				Payload: true,
			})

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
			board.Lock()
			// Sort cards by author
			sort.Slice(board.Cards, func(i, j int) bool {
				return board.Cards[i].Author < board.Cards[j].Author
			})
			board.Unlock()

			// Broadcast the sorted cards to all clients
			broadcastToClients(WSMessage{
				Type:    "cardsSorted",
				Payload: board.Cards,
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

func handleCards(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	switch r.Method {
	case http.MethodGet:
		board.RLock()
		json.NewEncoder(w).Encode(board.Cards)
		board.RUnlock()

	case http.MethodPost:
		var card Card
		if err := json.NewDecoder(r.Body).Decode(&card); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		board.Lock()
		board.Cards = append(board.Cards, card)
		board.Unlock()

		// Broadcast the new card to all clients
		broadcastToClients(WSMessage{
			Type:    "cardAdded",
			Payload: card,
		})

		json.NewEncoder(w).Encode(card)

	case http.MethodDelete:
		cardID := r.URL.Query().Get("id")
		if cardID == "" {
			http.Error(w, "Card ID is required", http.StatusBadRequest)
			return
		}

		board.Lock()
		for i, card := range board.Cards {
			if card.ID == cardID {
				// Remove the card by swapping with the last element and truncating
				board.Cards[i] = board.Cards[len(board.Cards)-1]
				board.Cards = board.Cards[:len(board.Cards)-1]

				// Broadcast the deletion to all clients
				broadcastToClients(WSMessage{
					Type:    "cardDeleted",
					Payload: cardID,
				})
				break
			}
		}
		board.Unlock()

		w.WriteHeader(http.StatusOK)

	case http.MethodPatch:
		var updateData struct {
			ID        string `json:"id"`
			NewColumn string `json:"newColumn"`
		}
		if err := json.NewDecoder(r.Body).Decode(&updateData); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		board.Lock()
		for i, card := range board.Cards {
			if card.ID == updateData.ID {
				board.Cards[i].Column = updateData.NewColumn

				// Broadcast the update to all clients
				broadcastToClients(WSMessage{
					Type: "cardMoved",
					Payload: struct {
						ID        string `json:"id"`
						NewColumn string `json:"newColumn"`
					}{
						ID:        updateData.ID,
						NewColumn: updateData.NewColumn,
					},
				})

				json.NewEncoder(w).Encode(board.Cards[i])
				board.Unlock()
				return
			}
		}
		board.Unlock()
		http.Error(w, "Card not found", http.StatusNotFound)

	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func getBoardState() WSMessage {
	board.RLock()
	defer board.RUnlock()

	return WSMessage{
		Type: "boardState",
		Payload: map[string]interface{}{
			"cards":       board.Cards,
			"usedColors":  board.UsedColors,
			"hideContent": board.HideContent,
		},
	}
}

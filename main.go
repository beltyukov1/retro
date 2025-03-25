package main

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"

	"github.com/gorilla/websocket"
)

type Card struct {
	ID     string `json:"id"`
	Text   string `json:"text"`
	Column string `json:"column"`
	Author string `json:"author"`
}

type RetroBoard struct {
	sync.RWMutex
	Cards []Card
}

type WSMessage struct {
	Type    string      `json:"type"`
	Payload interface{} `json:"payload"`
}

var board RetroBoard
var clients = make(map[*websocket.Conn]bool)
var clientsMutex sync.RWMutex

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true // Allow all origins in development
	},
}

func main() {
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
	}()

	// Send initial cards
	board.RLock()
	initialMsg := WSMessage{
		Type:    "init",
		Payload: board.Cards,
	}
	board.RUnlock()
	conn.WriteJSON(initialMsg)

	// Handle incoming messages (if needed in the future)
	for {
		_, _, err := conn.ReadMessage()
		if err != nil {
			break
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

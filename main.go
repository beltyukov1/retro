package main

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"
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

var board RetroBoard

func main() {
	// Serve static files
	fs := http.FileServer(http.Dir("static"))
	http.Handle("/", fs)

	// API endpoints
	http.HandleFunc("/api/cards", handleCards)

	log.Println("Server starting on http://localhost:8080")
	log.Fatal(http.ListenAndServe(":8080", nil))
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

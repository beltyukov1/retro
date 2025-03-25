let ws;
let usedColors = {}; // Add global usedColors object

// Check if user is authenticated
document.addEventListener('DOMContentLoaded', () => {
    const displayName = localStorage.getItem('displayName');
    if (!displayName) {
        window.location.href = '/';
        return;
    }

    // Update UI with display name
    document.getElementById('current-user').textContent = displayName;
    
    // Connect to WebSocket instead of fetching cards directly
    connectWebSocket();
    setupDropZones();
    setupAddCardInputs();
});

function connectWebSocket() {
    // Create WebSocket connection
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    ws.onopen = () => {
        console.log('Connected to WebSocket');
    };

    ws.onclose = () => {
        console.log('Disconnected from WebSocket');
        // Try to reconnect after a delay
        setTimeout(connectWebSocket, 3000);
    };

    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
    };

    ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        handleWebSocketMessage(message);
    };
}

function handleWebSocketMessage(message) {
    switch (message.type) {
        case 'init':
            // Clear existing cards
            document.querySelectorAll('.cards').forEach(column => {
                column.innerHTML = '';
            });
            // Add all cards from the initial state
            message.payload.cards.forEach(card => {
                const cardElement = createCardElement(card.text, card.id, card.author, card.color);
                document.getElementById(card.column).appendChild(cardElement);
            });
            // Update color picker with used colors
            usedColors = message.payload.usedColors;
            updateColorPicker(usedColors);
            break;

        case 'cardAdded':
            const card = message.payload;
            // Only add the card if it wasn't created by the current user
            if (card.author !== localStorage.getItem('displayName')) {
                const cardElement = createCardElement(card.text, card.id, card.author, card.color);
                document.getElementById(card.column).appendChild(cardElement);
            }
            break;

        case 'cardDeleted':
            const cardId = message.payload;
            const cardToDelete = document.querySelector(`[data-card-id="${cardId}"]`);
            if (cardToDelete) {
                cardToDelete.remove();
            }
            break;

        case 'cardMoved':
            const moveData = message.payload;
            const cardElement = document.querySelector(`[data-card-id="${moveData.id}"]`);
            if (cardElement) {
                document.getElementById(moveData.newColumn).appendChild(cardElement);
            }
            break;

        case 'colorUsed':
            usedColors[message.payload] = true;
            updateColorPicker(usedColors);
            break;

        case 'colorReleased':
            delete usedColors[message.payload];
            updateColorPicker(usedColors);
            break;
    }
}

function updateColorPicker(usedColors) {
    document.querySelectorAll('.color-option').forEach(button => {
        const color = button.dataset.color;
        if (usedColors[color]) {
            button.disabled = true;
            button.style.opacity = '0.5';
            button.style.cursor = 'not-allowed';
        } else {
            button.disabled = false;
            button.style.opacity = '1';
            button.style.cursor = 'pointer';
        }
    });
}

function logout() {
    if (ws) {
        // Send logout message with the user's color
        const userColor = localStorage.getItem('userColor');
        if (userColor) {
            ws.send(JSON.stringify({
                type: 'logout',
                color: userColor
            }));
        }
        ws.close();
    }
    localStorage.removeItem('displayName');
    localStorage.removeItem('userColor');
    window.location.href = '/';
}

function setupDropZones() {
    const dropZones = document.querySelectorAll('.cards');
    dropZones.forEach(zone => {
        zone.addEventListener('dragover', (e) => {
            e.preventDefault();
            const draggingElement = document.querySelector('.dragging');
            if (draggingElement) {
                zone.classList.add('drag-over');
            }
        });

        zone.addEventListener('dragleave', (e) => {
            zone.classList.remove('drag-over');
        });

        zone.addEventListener('drop', async (e) => {
            e.preventDefault();
            zone.classList.remove('drag-over');
            const cardElement = document.querySelector('.dragging');
            if (cardElement) {
                const cardId = cardElement.dataset.cardId;
                const newColumn = zone.id;
                
                try {
                    const response = await fetch('/api/cards', {
                        method: 'PATCH',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({
                            id: cardId,
                            newColumn: newColumn
                        })
                    });

                    if (response.ok) {
                        zone.appendChild(cardElement);
                    } else {
                        throw new Error('Failed to update card position');
                    }
                } catch (error) {
                    console.error('Error moving card:', error);
                    alert('Failed to move card. Please try again.');
                }
            }
        });
    });
}

async function deleteCard(cardId, cardElement) {
    try {
        const response = await fetch(`/api/cards?id=${cardId}`, {
            method: 'DELETE'
        });

        if (response.ok) {
            cardElement.remove();
        } else {
            throw new Error('Failed to delete card');
        }
    } catch (error) {
        console.error('Error deleting card:', error);
        alert('Failed to delete card. Please try again.');
    }
}

function setupAddCardInputs() {
    document.querySelectorAll('.add-card-input').forEach(input => {
        input.addEventListener('keypress', async (e) => {
            if (e.key === 'Enter') {
                const text = input.value.trim();
                if (text) {
                    try {
                        const cardId = Date.now().toString();
                        const displayName = localStorage.getItem('displayName');
                        const userColor = localStorage.getItem('userColor');
                        const columnId = input.dataset.column;
                        
                        const response = await fetch('/api/cards', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify({
                                id: cardId,
                                text: text,
                                column: columnId,
                                author: displayName,
                                color: userColor
                            })
                        });

                        if (response.ok) {
                            const cardElement = createCardElement(text, cardId, displayName, userColor);
                            document.getElementById(columnId).appendChild(cardElement);
                            input.value = ''; // Clear the input
                        } else {
                            throw new Error('Failed to save card');
                        }
                    } catch (error) {
                        console.error('Error saving card:', error);
                        alert('Failed to save card. Please try again.');
                    }
                }
            }
        });
    });
}

function createCardElement(text, cardId, author, color) {
    const cardElement = document.createElement('div');
    cardElement.className = 'card';
    cardElement.draggable = true;
    cardElement.dataset.cardId = cardId;
    
    // Apply the background color
    if (color) {
        cardElement.style.backgroundColor = color;
    }
    
    cardElement.addEventListener('dragstart', () => {
        cardElement.classList.add('dragging');
    });
    
    cardElement.addEventListener('dragend', () => {
        cardElement.classList.remove('dragging');
        document.querySelectorAll('.cards').forEach(zone => {
            zone.classList.remove('drag-over');
        });
    });
    
    const textDiv = document.createElement('div');
    textDiv.className = 'card-text';
    textDiv.textContent = text;

    const authorDiv = document.createElement('div');
    authorDiv.className = 'card-author';
    authorDiv.textContent = author;
    
    const deleteButton = document.createElement('button');
    deleteButton.className = 'delete-button';
    deleteButton.innerHTML = '&times;';
    deleteButton.onclick = (e) => {
        e.stopPropagation();
        if (confirm('Are you sure you want to delete this card?')) {
            deleteCard(cardId, cardElement);
        }
    };
    
    const contentDiv = document.createElement('div');
    contentDiv.className = 'card-content';
    contentDiv.appendChild(textDiv);
    contentDiv.appendChild(authorDiv);
    
    cardElement.appendChild(contentDiv);
    cardElement.appendChild(deleteButton);
    
    return cardElement;
} 
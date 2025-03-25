let ws;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY = 3000;
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
    setupHideContentToggle();
});

function connectWebSocket() {
    // Create WebSocket connection
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    ws.onopen = () => {
        console.log('Connected to WebSocket');
        reconnectAttempts = 0; // Reset reconnect attempts on successful connection
        
        // Request initial board state after connection
        const userColor = localStorage.getItem('userColor');
        if (userColor) {
            ws.send(JSON.stringify({
                type: 'join',
                payload: {
                    color: userColor
                }
            }));
        }
    };

    ws.onclose = (event) => {
        console.log('Disconnected from WebSocket:', event.code, event.reason);
        
        // Don't try to reconnect if this was an intentional closure (logout)
        if (event.code === 1000 && event.reason === 'Logout') {
            console.log('Intentional logout, not reconnecting');
            return;
        }
        
        if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            console.log(`Attempting to reconnect (${reconnectAttempts + 1}/${MAX_RECONNECT_ATTEMPTS})...`);
            setTimeout(() => {
                reconnectAttempts++;
                connectWebSocket();
            }, RECONNECT_DELAY);
        } else {
            console.log('Max reconnection attempts reached. Please refresh the page.');
            alert('Lost connection to the server. Please refresh the page to reconnect.');
        }
    };

    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
    };

    ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        handleWebSocketMessage(message);
    };

    // Add visibility change handler
    document.addEventListener('visibilitychange', handleVisibilityChange);
}

function handleVisibilityChange() {
    if (document.visibilityState === 'visible') {
        // Check if WebSocket is closed or closing
        if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
            console.log('Page visible, reconnecting WebSocket...');
            reconnectAttempts = 0; // Reset attempts when user returns
            connectWebSocket();
        } else if (ws.readyState === WebSocket.OPEN) {
            // If connection is open, request current state
            const userColor = localStorage.getItem('userColor');
            if (userColor) {
                ws.send(JSON.stringify({
                    type: 'join',
                    payload: {
                        color: userColor
                    }
                }));
            }
        }
    }
}

function handleWebSocketMessage(message) {
    switch (message.type) {
        case 'cardAdded':
            addCardToBoard(message.payload);
            break;
        case 'cardDeleted':
            deleteCardFromBoard(message.payload);
            break;
        case 'cardMoved':
            moveCardInBoard(message.payload.id, message.payload.newColumn);
            break;
        case 'colorUsed':
            usedColors[message.payload] = true;
            updateColorPicker(usedColors);
            break;
        case 'colorReleased':
            delete usedColors[message.payload];
            updateColorPicker(usedColors);
            break;
        case 'hideContentToggled':
            const toggle = document.getElementById('hide-content-toggle');
            toggle.checked = message.payload;
            updateCardVisibility(message.payload);
            break;
        case 'boardState':
            // Handle initial board state
            if (message.payload.cards) {
                message.payload.cards.forEach(card => addCardToBoard(card));
            }
            if (message.payload.usedColors) {
                Object.assign(usedColors, message.payload.usedColors);
                updateColorPicker(usedColors);
            }
            if (message.payload.hideContent !== undefined) {
                const toggle = document.getElementById('hide-content-toggle');
                toggle.checked = message.payload.hideContent;
                updateCardVisibility(message.payload.hideContent);
            }
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
                payload: {
                    color: userColor
                }
            }));
        }
        // Close with normal closure code
        ws.close(1000, 'Logout');
    }
    // Remove visibility change handler
    document.removeEventListener('visibilitychange', handleVisibilityChange);
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

        zone.addEventListener('drop', (e) => {
            e.preventDefault();
            zone.classList.remove('drag-over');
            const cardElement = document.querySelector('.dragging');
            if (cardElement) {
                const cardId = cardElement.dataset.cardId;
                const newColumn = zone.id;
                
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        type: 'moveCard',
                        payload: {
                            id: cardId,
                            newColumn: newColumn
                        }
                    }));
                    zone.appendChild(cardElement);
                } else {
                    console.error('WebSocket is not connected');
                    alert('Failed to move card. Please refresh the page.');
                }
            }
        });
    });
}

async function deleteCard(cardId, cardElement) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'deleteCard',
            payload: cardId
        }));
        cardElement.remove();
    } else {
        console.error('WebSocket is not connected');
        alert('Failed to delete card. Please refresh the page.');
    }
}

function setupAddCardInputs() {
    document.querySelectorAll('.add-card-input').forEach(input => {
        input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                const text = input.value.trim();
                if (text) {
                    const cardId = Date.now().toString();
                    const displayName = localStorage.getItem('displayName');
                    const userColor = localStorage.getItem('userColor');
                    const columnId = input.dataset.column;
                    
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        const card = {
                            id: cardId,
                            text: text,
                            column: columnId,
                            author: displayName,
                            color: userColor
                        };
                        
                        ws.send(JSON.stringify({
                            type: 'addCard',
                            payload: card
                        }));
                        
                        const cardElement = createCardElement(text, cardId, displayName, userColor);
                        document.getElementById(columnId).appendChild(cardElement);
                        input.value = ''; // Clear the input
                    } else {
                        console.error('WebSocket is not connected');
                        alert('Failed to add card. Please refresh the page.');
                    }
                }
            }
        });
    });
}

function setupHideContentToggle() {
    const toggle = document.getElementById('hide-content-toggle');
    toggle.addEventListener('change', () => {
        const isHidden = toggle.checked;
        updateCardVisibility(isHidden);
        
        // Send the toggle state to the server
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'toggleHideContent',
                payload: isHidden
            }));
        }
    });
}

function updateCardVisibility(isHidden) {
    document.querySelectorAll('.card-text').forEach(textElement => {
        if (isHidden) {
            textElement.dataset.originalText = textElement.textContent;
            textElement.textContent = 'Hidden';
            textElement.classList.add('hidden-content');
        } else {
            textElement.textContent = textElement.dataset.originalText;
            textElement.classList.remove('hidden-content');
        }
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
    textDiv.dataset.originalText = text; // Store original text
    
    // Check if content should be hidden based on current toggle state
    const toggle = document.getElementById('hide-content-toggle');
    if (toggle && toggle.checked) {
        textDiv.textContent = 'Hidden';
        textDiv.classList.add('hidden-content');
    }
    
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

function addCardToBoard(card) {
    // Only add the card if it wasn't created by the current user
    if (card.author !== localStorage.getItem('displayName')) {
        const cardElement = createCardElement(card.text, card.id, card.author, card.color);
        document.getElementById(card.column).appendChild(cardElement);
    }
}

function deleteCardFromBoard(cardId) {
    const cardToDelete = document.querySelector(`[data-card-id="${cardId}"]`);
    if (cardToDelete) {
        cardToDelete.remove();
    }
}

function moveCardInBoard(cardId, newColumn) {
    const cardElement = document.querySelector(`[data-card-id="${cardId}"]`);
    if (cardElement) {
        document.getElementById(newColumn).appendChild(cardElement);
    }
} 
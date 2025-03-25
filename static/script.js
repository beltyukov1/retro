let ws;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY = 3000;
let usedColors = {}; // Add global usedColors object
let currentSortOrder = 'asc'; // Start with ascending order

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
        const displayName = localStorage.getItem('displayName');
        if (userColor && displayName) {
            ws.send(JSON.stringify({
                type: 'join',
                payload: {
                    color: userColor,
                    username: displayName
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
            const displayName = localStorage.getItem('displayName');
            if (userColor && displayName) {
                ws.send(JSON.stringify({
                    type: 'join',
                    payload: {
                        color: userColor,
                        username: displayName
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
            const { id, newColumn } = message.payload;
            const cardElement = document.querySelector(`[data-card-id="${id}"]`);
            const columnElement = document.getElementById(newColumn);
            
            if (cardElement && columnElement) {
                columnElement.appendChild(cardElement);
            }
            break;
        case 'cardsSorted':
            updateBoardWithSortedCards(message.payload);
            break;
        case 'cardLiked':
            updateCardLikes(message.payload);
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
        case 'error':
            // Display error message from server
            alert(message.payload);
            // If we're on the board page and get an error, it might be a duplicate name error
            // In this case, we should redirect back to the login page
            if (window.location.pathname.includes('board.html')) {
                localStorage.removeItem('displayName');
                localStorage.removeItem('userColor');
                window.location.href = '/';
            }
            break;
        case 'joinSuccess':
            // Successfully joined with username
            console.log('Successfully joined the board');
            break;
        case 'boardState':
            // Clear existing cards before adding new ones from board state
            document.querySelectorAll('.cards').forEach(column => {
                column.innerHTML = '';
            });
            
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
        // Send logout message with the user's color and username
        const userColor = localStorage.getItem('userColor');
        const displayName = localStorage.getItem('displayName');
        if (userColor) {
            ws.send(JSON.stringify({
                type: 'logout',
                payload: {
                    color: userColor,
                    username: displayName
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
                // Only allow dropping if the card is coming from a different column
                const sourceColumn = draggingElement.parentElement;
                if (sourceColumn !== zone) {
                    zone.classList.add('drag-over');
                }
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
                const sourceColumn = cardElement.parentElement;
                
                // Only process the drop if it's to a different column
                if (sourceColumn.id !== newColumn) {
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'moveCard',
                            payload: {
                                id: cardId,
                                newColumn: newColumn
                            }
                        }));
                    } else {
                        console.error('WebSocket is not connected');
                        alert('Failed to move card. Please refresh the page.');
                    }
                }
            }
        });
    });
}

async function deleteCard(cardId, cardElement) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        const currentUser = localStorage.getItem('displayName');
        ws.send(JSON.stringify({
            type: 'deleteCard',
            payload: {
                id: cardId,
                authorName: currentUser
            }
        }));
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
    const currentUser = localStorage.getItem('displayName');
    const sortButton = document.querySelector('.sort-button');
    
    // Disable sort button when content is hidden
    if (sortButton) {
        if (isHidden) {
            sortButton.disabled = true;
            sortButton.style.opacity = '0.5';
            sortButton.style.cursor = 'not-allowed';
        } else {
            sortButton.disabled = false;
            sortButton.style.opacity = '1';
            sortButton.style.cursor = 'pointer';
        }
    }
    
    document.querySelectorAll('.card').forEach(cardElement => {
        const textElement = cardElement.querySelector('.card-text');
        const authorElement = cardElement.querySelector('.card-author');
        const likeContainer = cardElement.querySelector('.like-container');
        const isCurrentUserCard = authorElement && authorElement.textContent === currentUser;
        
        if (isHidden && !isCurrentUserCard) {
            // Only save original text if we haven't already (prevents overwriting with "Hidden")
            if (!textElement.dataset.originalText || textElement.textContent !== 'Hidden') {
                textElement.dataset.originalText = textElement.textContent;
            }
            textElement.textContent = 'Hidden';
            textElement.classList.add('hidden-content');
            cardElement.classList.add('has-hidden-content');
            
            // Hide like container
            if (likeContainer) {
                likeContainer.style.display = 'none';
            }
        } else {
            // Restore original text if it exists
            if (textElement.dataset.originalText && textElement.dataset.originalText !== 'Hidden') {
                textElement.textContent = textElement.dataset.originalText;
            }
            textElement.classList.remove('hidden-content');
            cardElement.classList.remove('has-hidden-content');
            
            // Show like container
            if (likeContainer) {
                likeContainer.style.display = 'flex';
            }
        }
    });
}

function createCardElement(text, cardId, author, color, likes = 0, userLiked = false) {
    const cardElement = document.createElement('div');
    cardElement.className = 'card';
    
    // Enable dragging for moving between columns
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
    
    // Check if content should be hidden based on current toggle state and author
    const toggle = document.getElementById('hide-content-toggle');
    const currentUser = localStorage.getItem('displayName');
    const shouldHideContent = toggle && toggle.checked && author !== currentUser;
    
    if (shouldHideContent) {
        textDiv.textContent = 'Hidden';
        textDiv.classList.add('hidden-content');
        cardElement.classList.add('has-hidden-content');
    }
    
    const authorDiv = document.createElement('div');
    authorDiv.className = 'card-author';
    authorDiv.textContent = author;
    
    const deleteButton = document.createElement('button');
    deleteButton.className = 'delete-button';
    deleteButton.innerHTML = '&times;';
    deleteButton.onclick = (e) => {
        e.stopPropagation();
        deleteCard(cardId, cardElement);
    };
    
    // Only show delete button for cards created by the current user
    if (author !== currentUser) {
        deleteButton.style.display = 'none';
    }
    
    const contentDiv = document.createElement('div');
    contentDiv.className = 'card-content';
    contentDiv.appendChild(textDiv);
    contentDiv.appendChild(authorDiv);
    
    // Create like container with heart icon and counter
    const likeContainer = document.createElement('div');
    likeContainer.className = 'like-container';
    likeContainer.dataset.cardId = cardId;
    
    // Hide like container if content is hidden
    if (shouldHideContent) {
        likeContainer.style.display = 'none';
    }
    
    const heartIcon = document.createElement('span');
    heartIcon.className = 'heart-icon';
    heartIcon.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"></path></svg>';
    if (userLiked) {
        heartIcon.classList.add('filled');
    }
    
    const likeCount = document.createElement('span');
    likeCount.className = 'like-count';
    likeCount.textContent = likes.toString();
    
    // Add click event to like container
    likeContainer.addEventListener('click', function() {
        const count = parseInt(likeCount.textContent);
        if (!heartIcon.classList.contains('filled')) {
            heartIcon.classList.add('filled');
            likeCount.textContent = (count + 1).toString();
            // Send like action to server
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'likeCard',
                    payload: {
                        cardId: cardId,
                        liked: true
                    }
                }));
            }
        } else {
            heartIcon.classList.remove('filled');
            likeCount.textContent = Math.max(0, count - 1).toString();
            // Send unlike action to server
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'likeCard',
                    payload: {
                        cardId: cardId,
                        liked: false
                    }
                }));
            }
        }
    });
    
    likeContainer.appendChild(heartIcon);
    likeContainer.appendChild(likeCount);
    
    cardElement.appendChild(contentDiv);
    cardElement.appendChild(likeContainer);
    cardElement.appendChild(deleteButton);
    
    return cardElement;
}

function addCardToBoard(card) {
    const likes = card.likes || 0;
    const userLiked = card.userLiked || false;
    const cardElement = createCardElement(card.text, card.id, card.author, card.color, likes, userLiked);
    document.getElementById(card.column).appendChild(cardElement);
}

function deleteCardFromBoard(cardId) {
    const cardToDelete = document.querySelector(`[data-card-id="${cardId}"]`);
    if (cardToDelete) {
        cardToDelete.remove();
    }
}

function sortCards() {
    // Toggle sort order between asc and desc only
    currentSortOrder = currentSortOrder === 'asc' ? 'desc' : 'asc';
    
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'sortCards',
            payload: {
                sortOrder: currentSortOrder
            }
        }));
    } else {
        console.error('WebSocket is not connected');
        alert('Failed to sort cards. Please refresh the page.');
    }
}

function updateBoardWithSortedCards(sortedCards) {
    // Clear all columns
    document.querySelectorAll('.cards').forEach(column => {
        column.innerHTML = '';
    });

    // Add cards back in sorted order
    sortedCards.forEach(card => {
        addCardToBoard(card);
    });
}

function updateCardLikes(data) {
    const { cardId, likeCount, liked } = data;
    const cardElement = document.querySelector(`[data-card-id="${cardId}"]`);
    
    if (cardElement) {
        const likeContainer = cardElement.querySelector('.like-container');
        if (likeContainer) {
            const heartIcon = likeContainer.querySelector('.heart-icon');
            const likeCountElement = likeContainer.querySelector('.like-count');
            
            // Update like count
            likeCountElement.textContent = likeCount.toString();
            
            // Update heart icon status if this was the current user's action
            if (liked !== undefined) {
                if (liked) {
                    heartIcon.classList.add('filled');
                } else {
                    heartIcon.classList.remove('filled');
                }
            }
        }
    }
} 
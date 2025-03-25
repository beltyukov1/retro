// Load existing cards when the page loads
document.addEventListener('DOMContentLoaded', () => {
    fetchCards();
    setupDropZones();
});

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

async function fetchCards() {
    try {
        const response = await fetch('/api/cards');
        const cards = await response.json();
        
        // Clear existing cards
        document.querySelectorAll('.cards').forEach(column => {
            column.innerHTML = '';
        });

        // Add cards to their respective columns
        cards.forEach(card => {
            const cardElement = createCardElement(card.text, card.id);
            document.getElementById(card.column).appendChild(cardElement);
        });
    } catch (error) {
        console.error('Error fetching cards:', error);
    }
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

function addCard(columnId) {
    const cardElement = document.createElement('div');
    cardElement.className = 'card';
    
    const textarea = document.createElement('textarea');
    textarea.placeholder = 'Enter your text here...';
    textarea.rows = 3;
    
    const buttonContainer = document.createElement('div');
    buttonContainer.className = 'card-buttons';
    
    const saveButton = document.createElement('button');
    saveButton.className = 'save-button';
    saveButton.textContent = 'Save';
    saveButton.onclick = async () => {
        const text = textarea.value.trim();
        if (text) {
            try {
                const cardId = Date.now().toString();
                const response = await fetch('/api/cards', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        id: cardId,
                        text: text,
                        column: columnId
                    })
                });

                if (response.ok) {
                    // Replace the editing view with the final card view
                    const newCardElement = createCardElement(text, cardId);
                    cardElement.parentNode.replaceChild(newCardElement, cardElement);
                } else {
                    throw new Error('Failed to save card');
                }
            } catch (error) {
                console.error('Error saving card:', error);
                alert('Failed to save card. Please try again.');
            }
        }
    };

    const cancelButton = document.createElement('button');
    cancelButton.className = 'cancel-button';
    cancelButton.textContent = 'Cancel';
    cancelButton.onclick = () => {
        cardElement.remove();
    };

    buttonContainer.appendChild(saveButton);
    buttonContainer.appendChild(cancelButton);
    
    cardElement.appendChild(textarea);
    cardElement.appendChild(buttonContainer);
    
    document.getElementById(columnId).appendChild(cardElement);
    textarea.focus();
}

function createCardElement(text, cardId) {
    const cardElement = document.createElement('div');
    cardElement.className = 'card';
    cardElement.draggable = true;
    cardElement.dataset.cardId = cardId;
    
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
    
    const deleteButton = document.createElement('button');
    deleteButton.className = 'delete-button';
    deleteButton.innerHTML = '&times;';
    deleteButton.onclick = (e) => {
        e.stopPropagation();
        if (confirm('Are you sure you want to delete this card?')) {
            deleteCard(cardId, cardElement);
        }
    };
    
    cardElement.appendChild(textDiv);
    cardElement.appendChild(deleteButton);
    
    return cardElement;
} 
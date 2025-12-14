// UI Helper Functions
const UIHelper = {
  // Show status message
  showStatus(message, type = 'info') {
    const statusElement = document.getElementById('status-message');
    if (statusElement) {
      statusElement.textContent = message;
      statusElement.className = `status-${type}`;
    }
  },

  // Create menu item element
  createMenuItem(item) {
    const menuItem = document.createElement('div');
    menuItem.className = 'menu-item';
    menuItem.innerHTML = `
      <h3>${this.escapeHtml(item.name)}</h3>
      <p>${this.escapeHtml(item.description)}</p>
      <p class="price">$${item.price.toFixed(2)}</p>
    `;
    return menuItem;
  },

  // Render menu items
  renderMenu(items) {
    const container = document.getElementById('menu-container');
    if (!container) return;

    container.innerHTML = '';
    items.forEach(item => {
      container.appendChild(this.createMenuItem(item));
    });
  },

  // Escape HTML to prevent XSS
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  },

  // Show loading state
  showLoading(elementId) {
    const element = document.getElementById(elementId);
    if (element) {
      element.innerHTML = '<p>Loading...</p>';
    }
  },

  // Show error state
  showError(elementId, message) {
    const element = document.getElementById(elementId);
    if (element) {
      element.innerHTML = `<p class="error">${this.escapeHtml(message)}</p>`;
    }
  }
};

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { UIHelper };
}

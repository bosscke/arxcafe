/**
 * @jest-environment jsdom
 */

const { UIHelper } = require('../js/ui');

describe('UIHelper', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="status-message"></div>
      <div id="menu-container"></div>
    `;
  });

  describe('showStatus', () => {
    test('should display status message', () => {
      UIHelper.showStatus('Test message', 'info');
      const statusElement = document.getElementById('status-message');
      expect(statusElement.textContent).toBe('Test message');
      expect(statusElement.className).toBe('status-info');
    });

    test('should handle different status types', () => {
      UIHelper.showStatus('Success!', 'success');
      const statusElement = document.getElementById('status-message');
      expect(statusElement.className).toBe('status-success');
    });
  });

  describe('createMenuItem', () => {
    test('should create menu item element', () => {
      const item = {
        name: 'Coffee',
        description: 'Hot coffee',
        price: 2.50
      };

      const element = UIHelper.createMenuItem(item);
      expect(element.className).toBe('menu-item');
      expect(element.innerHTML).toContain('Coffee');
      expect(element.innerHTML).toContain('Hot coffee');
      expect(element.innerHTML).toContain('$2.50');
    });
  });

  describe('renderMenu', () => {
    test('should render menu items', () => {
      const items = [
        { name: 'Item 1', description: 'Desc 1', price: 1.00 },
        { name: 'Item 2', description: 'Desc 2', price: 2.00 }
      ];

      UIHelper.renderMenu(items);
      const container = document.getElementById('menu-container');
      expect(container.children.length).toBe(2);
    });

    test('should clear previous items', () => {
      const container = document.getElementById('menu-container');
      container.innerHTML = '<div>Old content</div>';

      UIHelper.renderMenu([
        { name: 'Item', description: 'Desc', price: 1.00 }
      ]);

      expect(container.children.length).toBe(1);
      expect(container.innerHTML).not.toContain('Old content');
    });
  });

  describe('escapeHtml', () => {
    test('should escape HTML special characters', () => {
      const escaped = UIHelper.escapeHtml('<script>alert("xss")</script>');
      expect(escaped).toBe('&lt;script&gt;alert("xss")&lt;/script&gt;');
    });

    test('should handle quotes', () => {
      const escaped = UIHelper.escapeHtml('"test"');
      expect(escaped).not.toContain('"');
    });
  });

  describe('showLoading', () => {
    test('should show loading state', () => {
      UIHelper.showLoading('menu-container');
      const container = document.getElementById('menu-container');
      expect(container.innerHTML).toContain('Loading...');
    });
  });

  describe('showError', () => {
    test('should show error message', () => {
      UIHelper.showError('menu-container', 'Error occurred');
      const container = document.getElementById('menu-container');
      expect(container.innerHTML).toContain('Error occurred');
      expect(container.innerHTML).toContain('class="error"');
    });
  });
});

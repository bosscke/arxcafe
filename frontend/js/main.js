// Main application initialization
document.addEventListener('DOMContentLoaded', async () => {
  // Initialize API service
  const apiService = new ApiService(API_CONFIG.BASE_URL);

  try {
    // Check API health
    const health = await apiService.checkHealth();
    UIHelper.showStatus(`Connected: ${health.message}`, 'success');

    // Get API info
    const apiInfo = await apiService.getApiInfo();
    console.log('API Info:', apiInfo);

    // Sample menu data (replace with API call when endpoint is ready)
    const sampleMenu = [
      { name: 'Espresso', description: 'Strong and bold', price: 2.50 },
      { name: 'Cappuccino', description: 'Creamy and smooth', price: 3.50 },
      { name: 'Latte', description: 'Mild and sweet', price: 4.00 },
      { name: 'Americano', description: 'Classic coffee', price: 2.75 }
    ];

    UIHelper.renderMenu(sampleMenu);
  } catch (error) {
    UIHelper.showStatus('Failed to connect to API', 'error');
    console.error('Initialization error:', error);
  }
});

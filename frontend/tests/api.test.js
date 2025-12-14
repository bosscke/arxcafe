/**
 * @jest-environment jsdom
 */

const { ApiService, API_CONFIG } = require('../js/api');

describe('ApiService', () => {
  let apiService;

  beforeEach(() => {
    apiService = new ApiService('http://localhost:5000');
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('Constructor', () => {
    test('should initialize with base URL', () => {
      expect(apiService.baseUrl).toBe('http://localhost:5000');
    });
  });

  describe('GET request', () => {
    test('should make successful GET request', async () => {
      const mockData = { message: 'Success' };
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockData
      });

      const result = await apiService.get('/test');
      expect(result).toEqual(mockData);
      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:5000/test',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            'Content-Type': 'application/json'
          })
        })
      );
    });

    test('should handle failed GET request', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: false,
        status: 404
      });

      await expect(apiService.get('/test')).rejects.toThrow('HTTP error! status: 404');
    });
  });

  describe('POST request', () => {
    test('should make successful POST request', async () => {
      const mockData = { id: 1, name: 'Test' };
      const postData = { name: 'Test' };
      
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockData
      });

      const result = await apiService.post('/test', postData);
      expect(result).toEqual(mockData);
      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:5000/test',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify(postData)
        })
      );
    });
  });

  describe('Health check', () => {
    test('should check API health', async () => {
      const mockHealth = { status: 'OK', message: 'Server is running' };
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockHealth
      });

      const result = await apiService.checkHealth();
      expect(result).toEqual(mockHealth);
    });
  });
});

describe('API_CONFIG', () => {
  test('should have correct base URL', () => {
    expect(API_CONFIG.BASE_URL).toBe('http://localhost:5000');
  });

  test('should have correct endpoints', () => {
    expect(API_CONFIG.ENDPOINTS).toHaveProperty('HEALTH');
    expect(API_CONFIG.ENDPOINTS).toHaveProperty('API');
    expect(API_CONFIG.ENDPOINTS).toHaveProperty('MENU');
  });
});

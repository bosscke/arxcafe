const request = require('supertest');
const app = require('../app');
const { connect, closeDatabase, clearDatabase } = require('./setup/testDb');

// Setup before all tests
beforeAll(async () => {
  await connect();
});

// Clean up after each test
afterEach(async () => {
  await clearDatabase();
});

// Close connection after all tests
afterAll(async () => {
  await closeDatabase();
});

describe('Health Check API', () => {
  test('GET /health should return 200 and status OK', async () => {
    const res = await request(app).get('/health');
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('status', 'OK');
    expect(res.body).toHaveProperty('message', 'Server is running');
  });
});

describe('API Root', () => {
  test('GET /api should return welcome message', async () => {
    const res = await request(app).get('/api');
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('message');
    expect(res.body.message).toContain('ArxCafe');
  });
});

describe('404 Handler', () => {
  test('GET /nonexistent should return 404', async () => {
    const res = await request(app).get('/nonexistent');
    expect(res.statusCode).toBe(404);
    expect(res.body).toHaveProperty('error');
  });
});

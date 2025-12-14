# ArxCafe - Quick Start Guide

## Installation

1. **Install Backend Dependencies:**
   ```bash
   cd backend
   npm install
   ```

2. **Install Frontend Dependencies:**
   ```bash
   cd frontend
   npm install
   ```

3. **Start MongoDB:**
   ```bash
   docker-compose up -d
   ```

## Running

### Start Backend Server
```bash
cd backend
npm run dev
```
→ Backend runs on http://localhost:5000

### Start Frontend Server
```bash
cd frontend
npm start
```
→ Frontend runs on http://localhost:3000

## Testing

### Backend Tests
```bash
cd backend
npm test              # Run all tests
npm run test:watch    # Watch mode
npm run test:coverage # With coverage
```

### Frontend Tests
```bash
cd frontend
npm test              # Run all tests
npm run test:watch    # Watch mode
npm run test:coverage # With coverage
```

## Test Environment Features

✅ **Backend:**
- Jest testing framework
- Supertest for API testing
- MongoDB Memory Server (no external DB needed for tests)
- Automatic test isolation

✅ **Frontend:**
- Jest with jsdom
- Testing Library
- Mock fetch API
- Component testing

✅ **Database:**
- Docker Compose setup
- Sample data initialization
- Separate test database

## API Endpoints

- `GET /health` - Health check
- `GET /api` - API info

## Troubleshooting

**MongoDB won't start?**
```bash
docker-compose down -v
docker-compose up -d
```

**Tests failing?**
```bash
npm test -- --clearCache
npm install
```

**Port already in use?**
- Backend: Change `PORT` in `.env`
- Frontend: Use different port with `python -m http.server 3001`

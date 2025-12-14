# ArxCafe Test Environment

A MERN stack application with comprehensive testing setup.

## Tech Stack

- **Frontend**: HTML, CSS, Vanilla JavaScript
- **Backend**: Node.js, Express
- **Database**: MongoDB (NoSQL)
- **API**: REST
- **Deployment**: Cloud Run (GCP)

## Project Structure

```
arxcafe/
├── backend/           # Node.js/Express API
│   ├── config/        # Database configuration
│   ├── models/        # MongoDB models
│   ├── tests/         # Backend tests
│   ├── app.js         # Express application
│   └── server.js      # Server entry point
├── frontend/          # Vanilla JavaScript frontend
│   ├── css/           # Stylesheets
│   ├── js/            # JavaScript modules
│   ├── tests/         # Frontend tests
│   └── index.html     # Main HTML file
├── docker-compose.yml # MongoDB containers
└── mongo-init.js      # Database initialization
```

## Setup Instructions

### Prerequisites

- Node.js (v18 or higher)
- Docker and Docker Compose
- Python 3 (for frontend development server)

### 1. Install Dependencies

**Backend:**
```bash
cd backend
npm install
```

**Frontend:**
```bash
cd frontend
npm install
```

### 2. Start MongoDB

```bash
# Start MongoDB container
docker-compose up -d

# Verify MongoDB is running
docker-compose ps
```

### 3. Configure Environment

Backend `.env` file is already created with default values. Modify if needed:
```
NODE_ENV=development
PORT=5000
MONGODB_URI=mongodb://localhost:27017/arxcafe
MONGODB_TEST_URI=mongodb://localhost:27017/arxcafe-test
```

## Running the Application

### Development Mode

**Backend:**
```bash
cd backend
npm run dev
```
Server runs on http://localhost:5000

**Frontend:**
```bash
cd frontend
npm start
```
Frontend runs on http://localhost:3000

Or use Python's HTTP server:
```bash
cd frontend
python -m http.server 3000
```

## Testing

### Backend Tests

```bash
cd backend

# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage
```

**Backend Testing Features:**
- Jest for testing framework
- Supertest for API testing
- MongoDB Memory Server for isolated database tests
- Automatic test database setup/teardown

### Frontend Tests

```bash
cd frontend

# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage
```

**Frontend Testing Features:**
- Jest with jsdom environment
- Testing Library for DOM testing
- Mock fetch API for testing
- Component and integration tests

## API Endpoints

### Health Check
- `GET /health` - Check if server is running

### API Info
- `GET /api` - Get API information

### Menu (to be implemented)
- `GET /api/menu` - Get all menu items
- `POST /api/menu` - Create new menu item
- `PUT /api/menu/:id` - Update menu item
- `DELETE /api/menu/:id` - Delete menu item

## Database Management

### Start MongoDB
```bash
docker-compose up -d
```

### Stop MongoDB
```bash
docker-compose down
```

### Reset Database
```bash
docker-compose down -v
docker-compose up -d
```

### Access MongoDB Shell
```bash
docker exec -it arxcafe-mongodb mongosh
```

## Testing Strategy

### Backend Testing
1. **Unit Tests**: Test models and utility functions
2. **Integration Tests**: Test API endpoints with in-memory database
3. **API Tests**: Test HTTP requests/responses with Supertest

### Frontend Testing
1. **Unit Tests**: Test JavaScript modules (api.js, ui.js)
2. **DOM Tests**: Test UI rendering and interactions
3. **Integration Tests**: Test component interactions

## Example Test Commands

```bash
# Run specific test file (backend)
cd backend
npm test -- tests/app.test.js

# Run specific test file (frontend)
cd frontend
npm test -- tests/api.test.js

# Run tests with verbose output
npm test -- --verbose

# Update snapshots (if using)
npm test -- -u
```

## Continuous Integration

The test setup is designed for CI/CD pipelines:
- Tests run in isolated environments
- No external dependencies required for testing
- MongoDB Memory Server for backend tests
- jsdom for frontend tests
- Fast test execution

## Cloud Run Deployment (GCP)

### Build Docker Image
```bash
# Create Dockerfile for backend
docker build -t gcr.io/[PROJECT-ID]/arxcafe-backend ./backend

# Push to Google Container Registry
docker push gcr.io/[PROJECT-ID]/arxcafe-backend

# Deploy to Cloud Run
gcloud run deploy arxcafe-backend \
  --image gcr.io/[PROJECT-ID]/arxcafe-backend \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated
```

## Troubleshooting

### MongoDB Connection Issues
- Ensure Docker is running: `docker ps`
- Check MongoDB logs: `docker-compose logs mongodb`
- Verify port 27017 is not in use: `netstat -an | findstr 27017`

### Test Failures
- Clear Jest cache: `npm test -- --clearCache`
- Ensure all dependencies are installed: `npm install`
- Check Node.js version: `node --version`

### Frontend CORS Issues
- Ensure backend is running on port 5000
- Check CORS configuration in app.js
- Verify API_CONFIG.BASE_URL in frontend/js/api.js

## Next Steps

1. Implement menu CRUD operations in backend
2. Create menu management UI in frontend
3. Add user authentication
4. Implement order management
5. Add payment integration
6. Create Dockerfile for production
7. Set up CI/CD pipeline

## Additional Resources

- [Express.js Documentation](https://expressjs.com/)
- [MongoDB Documentation](https://docs.mongodb.com/)
- [Jest Documentation](https://jestjs.io/)
- [Google Cloud Run](https://cloud.google.com/run/docs)

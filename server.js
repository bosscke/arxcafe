const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { MongoClient } = require('mongodb');
const googleTrends = require('google-trends-api');
const { handleAiExplain } = require('./ai-explain');

////////////////////////////////////////////
///// Server ARXCAFE

const trendKeywords = [
    'AWS Certified Solutions Architect – Associate',
    'Microsoft Azure Fundamentals (AZ-900)',
    'Google Professional Cloud Architect',
    'Certified Kubernetes Administrator (CKA)',
    'CompTIA Security+'
];

const fallbackTrends = trendKeywords.map(name => ({ name, score: 0 }));
let trendsCache = { updated: 0, items: fallbackTrends };

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const LOOKBACK_DAYS = 30;

const averageFromTimeline = (json) => {
    try {
        const parsed = JSON.parse(json);
        const points = parsed?.default?.timelineData || [];
        if (!points.length) return 0;
        const sum = points.reduce((s, p) => s + (p.value?.[0] || 0), 0);
        return sum / points.length;
    } catch (e) {
        return 0;
    }
};

const refreshTrends = async () => {
    const startTime = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    const results = await Promise.all(trendKeywords.map(async (keyword) => {
        const res = await googleTrends.interestOverTime({ keyword, startTime });
        return { name: keyword, score: averageFromTimeline(res) };
    }));
    const sorted = results.sort((a, b) => b.score - a.score).slice(0, 5);
    trendsCache = { updated: Date.now(), items: sorted };
    return trendsCache;
};

const getTrends = async () => {
    if (Date.now() - trendsCache.updated > CACHE_TTL_MS) {
        try {
            await refreshTrends();
        } catch (err) {
            // keep cached data on failure
        }
    }
    return trendsCache;
};

const serveStaticFile = (filePath, res) => {
    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404, {'Content-Type': 'text/plain'});
            res.end('Not found');
            return;
        }
        const ext = path.extname(filePath);
        const mimeTypes = {
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.png': 'image/png',
            '.gif': 'image/gif',
            '.svg': 'image/svg+xml',
            '.css': 'text/css',
            '.js': 'application/javascript'
        };
        const contentType = mimeTypes[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=3600' });
        res.end(data);
    });
};

// Development-only MongoDB connection (local MongoDB, managed via Compass)
// Uses MONGO_DEV_URI if provided, otherwise defaults to localhost.
const devMongoUri = process.env.MONGO_DEV_URI || 'mongodb://127.0.0.1:27017/arxcafe';
let mongoClient;
let mongoDb;

async function connectDevMongo() {
    // Only attempt connection in non-production environments
    if (process.env.NODE_ENV === 'production') {
        return;
    }

    try {
        mongoClient = new MongoClient(devMongoUri, {
            serverSelectionTimeoutMS: 3000,
        });
        await mongoClient.connect();
        mongoDb = mongoClient.db();
        console.log('[MongoDB] Connected to local development database:', mongoDb.databaseName);
    } catch (err) {
        console.error('[MongoDB] Failed to connect to local development database:', err.message);
    }
}

// Collection name for ML topics (used for legacy ML search)
const ML_TOPICS_COLLECTION = 'ml_topics';
// Collection name for knowledge base topics (HTML documents)
const TOPICS_COLLECTION = 'topics';

const server  = http.createServer((req,res) => {
    const pathName = req.url.split('?')[0];

    if (pathName === '/trends.json') {
        getTrends()
            .then((data) => {
                res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' });
                res.end(JSON.stringify({ items: data.items }));
            })
            .catch(() => {
                res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' });
                res.end(JSON.stringify({ items: trendsCache.items }));
            });
        return;
    }

    // Simple JSON search endpoint for ML topics (legacy)
    if (pathName === '/ml-topics.json') {
        (async () => {
            try {
                if (!mongoDb) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ items: [], error: 'ML topics search is not available (no database connection).' }));
                    return;
                }

                const url = new URL(req.url, 'http://localhost');
                const q = (url.searchParams.get('q') || '').trim();

                const coll = mongoDb.collection(ML_TOPICS_COLLECTION);
                const filter = q
                    ? { text: { $regex: q, $options: 'i' } }
                    : {};

                const docs = await coll
                    .find(filter)
                    .sort({ sectionOrder: 1, order: 1 })
                    .limit(50)
                    .toArray();

                const items = docs.map(doc => ({
                    section: doc.section,
                    text: doc.text,
                }));

                res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
                res.end(JSON.stringify({ items }));
            } catch (err) {
                console.error('[ML search] Failed:', err.message);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ items: [], error: 'Internal server error.' }));
            }
        })();
        return;
    }

    // JSON search endpoint for knowledge base topics (HTML documents)
    if (pathName === '/topics.json') {
        (async () => {
            try {
                if (!mongoDb) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ items: [], error: 'Knowledge base search is not available (no database connection).' }));
                    return;
                }

                const url = new URL(req.url, 'http://localhost');
                const q = (url.searchParams.get('q') || '').trim();

                if (!q || q.length < 2) {
                    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
                    res.end(JSON.stringify({ items: [] }));
                    return;
                }

                const coll = mongoDb.collection(TOPICS_COLLECTION);
                const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const regex = new RegExp(escaped, 'i');

                const docs = await coll
                    .find({
                        $or: [
                            { title: regex },
                            { keywords: regex },
                            { content_html: regex }
                        ]
                    })
                    .project({ title: 1, category: 1, difficulty: 1, tags: 1 })
                    .limit(20)
                    .toArray();

                const items = docs.map(doc => ({
                    id: doc._id,
                    title: doc.title,
                    category: doc.category || null,
                    difficulty: doc.difficulty || null,
                    tags: Array.isArray(doc.tags) ? doc.tags : []
                }));

                res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
                res.end(JSON.stringify({ items }));
            } catch (err) {
                console.error('[Topics search] Failed:', err.message);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ items: [], error: 'Internal server error.' }));
            }
        })();
        return;
    }

    // Knowledge base topic pages (HTML)
    if (pathName === '/topics/when-to-use-ml-vs-non-ml.html') {
        fs.readFile(path.join(__dirname, 'topics/when-to-use-ml-vs-non-ml.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Error loading topic');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
            res.end(data);
        });
        return;
    }

    // ML Engineer Quiz endpoint
    if (pathName === '/ml-quiz-questions.json') {
        (async () => {
            try {
                if (!mongoDb) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ questions: [], error: 'Database not connected' }));
                    return;
                }

                const url = new URL(req.url, 'http://localhost');
                const phase = url.searchParams.get('phase') || 'all';
                const domain = url.searchParams.get('domain') || 'all';

                const coll = mongoDb.collection('ml_engineer_questions');
                const filter = {};
                if (phase !== 'all') filter.phase = parseInt(phase);
                if (domain !== 'all') filter.domain = domain;

                const questions = await coll
                    .find(filter)
                    .sort({ _id: 1 })
                    .toArray();

                res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' });
                res.end(JSON.stringify({ questions: questions }));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ questions: [], error: err.message }));
            }
        })();
        return;
    }

    // AI explanation endpoint (Gemini 2.5)
    if (pathName === '/ai-explain.json') {
        if (req.method !== 'POST') {
            res.writeHead(405, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'POST required' }));
            return;
        }
        handleAiExplain(req, res, mongoDb);
        return;
    }

    // Serve static files (hero.jpg, CSS, JS) and handle leading '/'
    if (pathName.match(/\.(jpg|jpeg|png|gif|svg|css|js)$/)) {
        const staticPath = pathName.replace(/^\/+/, '');
        const filePath = path.join(__dirname, staticPath);
        serveStaticFile(filePath, res);
        return;
    }

    if(pathName==='/'||pathName==='/index' ){
        fs.readFile(path.join(__dirname, 'index.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/api' || pathName === '/api.html') {
        fs.readFile(path.join(__dirname, 'api.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/assesment' || pathName === '/assesment.html' || pathName === '/assessment' || pathName === '/assessment.html') {
        fs.readFile(path.join(__dirname, 'assesment.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/ml-engineer-quiz' || pathName === '/ml-engineer-quiz.html') {
        fs.readFile(path.join(__dirname, 'ml-engineer-quiz.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/lamp' || pathName === '/lamp.html') {
        fs.readFile(path.join(__dirname, 'stacks/web-application/lamp.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/lemp' || pathName === '/lemp.html') {
        fs.readFile(path.join(__dirname, 'stacks/web-application/lemp.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/wamp' || pathName === '/wamp.html') {
        fs.readFile(path.join(__dirname, 'stacks/web-application/wamp.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/mamp' || pathName === '/mamp.html') {
        fs.readFile(path.join(__dirname, 'stacks/web-application/mamp.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
        } else if (pathName === '/xampp' || pathName === '/xampp.html') {
            fs.readFile(path.join(__dirname, 'stacks/web-application/xampp.html'), 'utf8', (err, data) => {
                if (err) {
                    res.writeHead(500, {'Content-Type': 'text/plain'});
                    res.end('Error loading page');
                    return;
                }
                res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
                res.end(data);
            });
    } else if (pathName === '/mean' || pathName === '/mean.html') {
        fs.readFile(path.join(__dirname, 'stacks/web-application/mean.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/mern' || pathName === '/mern.html') {
        fs.readFile(path.join(__dirname, 'stacks/web-application/mern.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/mevn' || pathName === '/mevn.html') {
        fs.readFile(path.join(__dirname, 'stacks/web-application/mevn.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/menn' || pathName === '/menn.html') {
        fs.readFile(path.join(__dirname, 'stacks/web-application/menn.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/pern' || pathName === '/pern.html') {
        fs.readFile(path.join(__dirname, 'stacks/web-application/pern.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/t3' || pathName === '/t3.html') {
        fs.readFile(path.join(__dirname, 'stacks/web-application/t3.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/django' || pathName === '/django.html') {
        fs.readFile(path.join(__dirname, 'stacks/web-application/django.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/flask' || pathName === '/flask.html') {
        fs.readFile(path.join(__dirname, 'stacks/web-application/flask.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/fastapi' || pathName === '/fastapi.html') {
        fs.readFile(path.join(__dirname, 'stacks/web-application/fastapi.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/pydata' || pathName === '/pydata.html') {
        fs.readFile(path.join(__dirname, 'stacks/data-science/pydata.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/spring' || pathName === '/spring.html') {
        fs.readFile(path.join(__dirname, 'stacks/web-application/spring.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/jhipster' || pathName === '/jhipster.html') {
        fs.readFile(path.join(__dirname, 'stacks/web-application/jhipster.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/javaee' || pathName === '/javaee.html') {
        fs.readFile(path.join(__dirname, 'stacks/web-application/javaee.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/dotnet' || pathName === '/dotnet.html') {
        fs.readFile(path.join(__dirname, 'stacks/desktop/dotnet.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });    } else if (pathName === '/swift' || pathName === '/swift.html') {
        fs.readFile(path.join(__dirname, 'stacks/mobile/swift.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });    } else if (pathName === '/wisa' || pathName === '/wisa.html') {
        fs.readFile(path.join(__dirname, 'stacks/web-application/wisa.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/azure' || pathName === '/azure.html') {
        fs.readFile(path.join(__dirname, 'stacks/cloud/azure.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });    } else if (pathName === '/swift' || pathName === '/swift.html') {
        fs.readFile(path.join(__dirname, 'stacks/mobile/swift.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });    } else if (pathName === '/rails' || pathName === '/rails.html') {
        fs.readFile(path.join(__dirname, 'stacks/web-application/rails.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/rvm' || pathName === '/rvm.html') {
        fs.readFile(path.join(__dirname, 'stacks/web-application/rvm.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });    } else if (pathName === '/edge' || pathName === '/edge.html') {
        fs.readFile(path.join(__dirname, 'stacks/minimal/edge.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });    } else if (pathName === '/static' || pathName === '/static.html') {
        fs.readFile(path.join(__dirname, 'stacks/jamstack/static.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/headless' || pathName === '/headless.html') {
        fs.readFile(path.join(__dirname, 'stacks/jamstack/headless.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/jamstack' || pathName === '/jamstack.html') {
        fs.readFile(path.join(__dirname, 'stacks/jamstack/jamstack.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/symfony' || pathName === '/symfony.html') {
        fs.readFile(path.join(__dirname, 'stacks/php-frameworks/symfony.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/laravel' || pathName === '/laravel.html') {
        fs.readFile(path.join(__dirname, 'stacks/php-frameworks/laravel.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/kubernetes' || pathName === '/kubernetes.html') {
        fs.readFile(path.join(__dirname, 'stacks/cloud-native/kubernetes.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/elk' || pathName === '/elk.html') {
        fs.readFile(path.join(__dirname, 'stacks/cloud-native/elk.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });    } else if (pathName === '/bun' || pathName === '/bun.html') {
        fs.readFile(path.join(__dirname, 'stacks/minimal/bun.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });    } else if (pathName === '/efk' || pathName === '/efk.html') {
        fs.readFile(path.join(__dirname, 'stacks/cloud-native/efk.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/prometheus' || pathName === '/prometheus.html') {
        fs.readFile(path.join(__dirname, 'stacks/cloud-native/prometheus.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/hadoop' || pathName === '/hadoop.html') {
        fs.readFile(path.join(__dirname, 'stacks/data/hadoop.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/spark' || pathName === '/spark.html') {
        fs.readFile(path.join(__dirname, 'stacks/data/spark.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });    } else if (pathName === '/node' || pathName === '/node.html') {
        fs.readFile(path.join(__dirname, 'stacks/minimal/node.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });    } else if (pathName === '/kafka' || pathName === '/kafka.html') {
        fs.readFile(path.join(__dirname, 'stacks/data/kafka.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/react-native' || pathName === '/react-native.html') {
        fs.readFile(path.join(__dirname, 'stacks/mobile/react-native.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/flutter' || pathName === '/flutter.html') {
        fs.readFile(path.join(__dirname, 'stacks/mobile/flutter.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/concepts/client-server' || pathName === '/concepts/client-server.html') {
        fs.readFile(path.join(__dirname, 'concepts/client-server.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/concepts/http-vs-https' || pathName === '/concepts/http-vs-https.html') {
        fs.readFile(path.join(__dirname, 'concepts/http-vs-https.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/concepts/request-response' || pathName === '/concepts/request-response.html') {
        fs.readFile(path.join(__dirname, 'concepts/request-response.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/concepts/http-methods' || pathName === '/concepts/http-methods.html') {
        fs.readFile(path.join(__dirname, 'concepts/http-methods.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/concepts/http-status-codes' || pathName === '/concepts/http-status-codes.html') {
        fs.readFile(path.join(__dirname, 'concepts/http-status-codes.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/concepts/headers-and-body' || pathName === '/concepts/headers-and-body.html') {
        fs.readFile(path.join(__dirname, 'concepts/headers-and-body.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/concepts/domain-name-system' || pathName === '/concepts/domain-name-system.html') {
        fs.readFile(path.join(__dirname, 'concepts/domain-name-system.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/concepts/ip-address-public-vs-private' || pathName === '/concepts/ip-address-public-vs-private.html') {
        fs.readFile(path.join(__dirname, 'concepts/ip-address-public-vs-private.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/concepts/stateless-communication' || pathName === '/concepts/stateless-communication.html') {
        fs.readFile(path.join(__dirname, 'concepts/stateless-communication.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/concepts/dns-resolution' || pathName === '/concepts/dns-resolution.html') {
        fs.readFile(path.join(__dirname, 'concepts/dns-resolution.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/concepts/ports-80-443' || pathName === '/concepts/ports-80-443.html') {
        fs.readFile(path.join(__dirname, 'concepts/ports-80-443.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/concepts/tcp-vs-udp' || pathName === '/concepts/tcp-vs-udp.html') {
        fs.readFile(path.join(__dirname, 'concepts/tcp-vs-udp.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/concepts-intermediate/tls-handshake' || pathName === '/concepts-intermediate/tls-handshake.html') {
        fs.readFile(path.join(__dirname, 'concepts-intermediate/tls-handshake.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/concepts-intermediate/digital-certificates' || pathName === '/concepts-intermediate/digital-certificates.html') {
        fs.readFile(path.join(__dirname, 'concepts-intermediate/digital-certificates.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/concepts-intermediate/public-key-vs-private-key' || pathName === '/concepts-intermediate/public-key-vs-private-key.html') {
        fs.readFile(path.join(__dirname, 'concepts-intermediate/public-key-vs-private-key.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-intermediate/encryption-in-transit' || pathName === '/concepts-intermediate/encryption-in-transit.html') {
        fs.readFile(path.join(__dirname, 'concepts-intermediate/encryption-in-transit.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-intermediate/authentication-vs-authorization' || pathName === '/concepts-intermediate/authentication-vs-authorization.html') {
        fs.readFile(path.join(__dirname, 'concepts-intermediate/authentication-vs-authorization.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-intermediate/tokens-session-jwt-api-key' || pathName === '/concepts-intermediate/tokens-session-jwt-api-key.html') {
        fs.readFile(path.join(__dirname, 'concepts-intermediate/tokens-session-jwt-api-key.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-intermediate/application-architecture' || pathName === '/concepts-intermediate/application-architecture.html') {
        fs.readFile(path.join(__dirname, 'concepts-intermediate/application-architecture.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-intermediate/monolith' || pathName === '/concepts-intermediate/monolith.html') {
        fs.readFile(path.join(__dirname, 'concepts-intermediate/monolith.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-intermediate/microservices' || pathName === '/concepts-intermediate/microservices.html') {
        fs.readFile(path.join(__dirname, 'concepts-intermediate/microservices.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-intermediate/modular-monolith' || pathName === '/concepts-intermediate/modular-monolith.html') {
        fs.readFile(path.join(__dirname, 'concepts-intermediate/modular-monolith.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-intermediate/api-gateway' || pathName === '/concepts-intermediate/api-gateway.html') {
        fs.readFile(path.join(__dirname, 'concepts-intermediate/api-gateway.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-intermediate/synchronous-vs-asynchronous' || pathName === '/concepts-intermediate/synchronous-vs-asynchronous.html') {
        fs.readFile(path.join(__dirname, 'concepts-intermediate/synchronous-vs-asynchronous.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-intermediate/rest-apis' || pathName === '/concepts-intermediate/rest-apis.html') {
        fs.readFile(path.join(__dirname, 'concepts-intermediate/rest-apis.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-intermediate/json' || pathName === '/concepts-intermediate/json.html') {
        fs.readFile(path.join(__dirname, 'concepts-intermediate/json.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-intermediate/api-versioning' || pathName === '/concepts-intermediate/api-versioning.html') {
        fs.readFile(path.join(__dirname, 'concepts-intermediate/api-versioning.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-intermediate/pagination' || pathName === '/concepts-intermediate/pagination.html') {
        fs.readFile(path.join(__dirname, 'concepts-intermediate/pagination.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-intermediate/rate-limiting' || pathName === '/concepts-intermediate/rate-limiting.html') {
        fs.readFile(path.join(__dirname, 'concepts-intermediate/rate-limiting.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-intermediate/webhooks' || pathName === '/concepts-intermediate/webhooks.html') {
        fs.readFile(path.join(__dirname, 'concepts-intermediate/webhooks.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-intermediate/databases-relational' || pathName === '/concepts-intermediate/databases-relational.html') {
        fs.readFile(path.join(__dirname, 'concepts-intermediate/databases-relational.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-intermediate/databases-nosql' || pathName === '/concepts-intermediate/databases-nosql.html') {
        fs.readFile(path.join(__dirname, 'concepts-intermediate/databases-nosql.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-intermediate/read-vs-write-operations' || pathName === '/concepts-intermediate/read-vs-write-operations.html') {
        fs.readFile(path.join(__dirname, 'concepts-intermediate/read-vs-write-operations.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-intermediate/indexing' || pathName === '/concepts-intermediate/indexing.html') {
        fs.readFile(path.join(__dirname, 'concepts-intermediate/indexing.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-intermediate/caching' || pathName === '/concepts-intermediate/caching.html') {
        fs.readFile(path.join(__dirname, 'concepts-intermediate/caching.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-intermediate/backups' || pathName === '/concepts-intermediate/backups.html') {
        fs.readFile(path.join(__dirname, 'concepts-intermediate/backups.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-advance/vertical-scaling' || pathName === '/concepts-advance/vertical-scaling.html') {
        fs.readFile(path.join(__dirname, 'concepts-advance/vertical-scaling.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-advance/horizontal-scaling' || pathName === '/concepts-advance/horizontal-scaling.html') {
        fs.readFile(path.join(__dirname, 'concepts-advance/horizontal-scaling.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-advance/load-balancer' || pathName === '/concepts-advance/load-balancer.html') {
        fs.readFile(path.join(__dirname, 'concepts-advance/load-balancer.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-advance/cdn' || pathName === '/concepts-advance/cdn.html') {
        fs.readFile(path.join(__dirname, 'concepts-advance/cdn.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-advance/latency' || pathName === '/concepts-advance/latency.html') {
        fs.readFile(path.join(__dirname, 'concepts-advance/latency.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-advance/throughput' || pathName === '/concepts-advance/throughput.html') {
        fs.readFile(path.join(__dirname, 'concepts-advance/throughput.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-advance/health-checks' || pathName === '/concepts-advance/health-checks.html') {
        fs.readFile(path.join(__dirname, 'concepts-advance/health-checks.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-advance/failover' || pathName === '/concepts-advance/failover.html') {
        fs.readFile(path.join(__dirname, 'concepts-advance/failover.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-advance/replication' || pathName === '/concepts-advance/replication.html') {
        fs.readFile(path.join(__dirname, 'concepts-advance/replication.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-advance/high-availability' || pathName === '/concepts-advance/high-availability.html') {
        fs.readFile(path.join(__dirname, 'concepts-advance/high-availability.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-advance/disaster-recovery' || pathName === '/concepts-advance/disaster-recovery.html') {
        fs.readFile(path.join(__dirname, 'concepts-advance/disaster-recovery.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-advance/logging' || pathName === '/concepts-advance/logging.html') {
        fs.readFile(path.join(__dirname, 'concepts-advance/logging.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-advance/metrics' || pathName === '/concepts-advance/metrics.html') {
        fs.readFile(path.join(__dirname, 'concepts-advance/metrics.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-advance/monitoring' || pathName === '/concepts-advance/monitoring.html') {
        fs.readFile(path.join(__dirname, 'concepts-advance/monitoring.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-advance/alerts' || pathName === '/concepts-advance/alerts.html') {
        fs.readFile(path.join(__dirname, 'concepts-advance/alerts.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-advance/distributed-tracing' || pathName === '/concepts-advance/distributed-tracing.html') {
        fs.readFile(path.join(__dirname, 'concepts-advance/distributed-tracing.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-advance/cicd-pipeline' || pathName === '/concepts-advance/cicd-pipeline.html') {
        fs.readFile(path.join(__dirname, 'concepts-advance/cicd-pipeline.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-advance/build-test-deploy' || pathName === '/concepts-advance/build-test-deploy.html') {
        fs.readFile(path.join(__dirname, 'concepts-advance/build-test-deploy.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-advance/environments' || pathName === '/concepts-advance/environments.html') {
        fs.readFile(path.join(__dirname, 'concepts-advance/environments.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-advance/secrets-management' || pathName === '/concepts-advance/secrets-management.html') {
        fs.readFile(path.join(__dirname, 'concepts-advance/secrets-management.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-advance/rollback' || pathName === '/concepts-advance/rollback.html') {
        fs.readFile(path.join(__dirname, 'concepts-advance/rollback.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-advance/virtual-machines' || pathName === '/concepts-advance/virtual-machines.html') {
        fs.readFile(path.join(__dirname, 'concepts-advance/virtual-machines.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-advance/containers' || pathName === '/concepts-advance/containers.html') {
        fs.readFile(path.join(__dirname, 'concepts-advance/containers.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-advance/docker' || pathName === '/concepts-advance/docker.html') {
        fs.readFile(path.join(__dirname, 'concepts-advance/docker.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-advance/managed-services' || pathName === '/concepts-advance/managed-services.html') {
        fs.readFile(path.join(__dirname, 'concepts-advance/managed-services.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-advance/regions-availability-zones' || pathName === '/concepts-advance/regions-availability-zones.html') {
        fs.readFile(path.join(__dirname, 'concepts-advance/regions-availability-zones.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/sitexam') {
        res.end('sit the exam in arxcafe!');
    } else {
        res.writeHead(404);
        res.end('page not found');
    }
});

// WebSocket server for "currently online" counter
const wss = new WebSocket.Server({ server, path: '/ws' });
let activeConnections = 0;

const broadcastActiveCount = () => {
    const payload = JSON.stringify({ active: activeConnections });
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    });
};

wss.on('connection', (ws) => {
    activeConnections += 1;
    broadcastActiveCount();

    ws.on('close', () => {
        activeConnections = Math.max(0, activeConnections - 1);
        broadcastActiveCount();
    });
});

const PORT = process.env.PORT || 8080;

// Start HTTP server, then connect to local dev MongoDB (if not production)
server.listen(PORT, '0.0.0.0', () => {
    console.log(`The arxcafe server started on port ${PORT}`);
    console.log(`Server running at http://localhost:${PORT}`);
    connectDevMongo();
});
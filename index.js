import { WebSocketServer } from 'ws';
import express from 'express';
import pg from 'pg';
import dotenv from 'dotenv';

// Configuration
dotenv.config();
const { Pool } = pg;
const app = express();
const port = process.env.PUMP_CONTROL_PORT || 3001;

// Set up PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Initialize pump status table
async function initPumpStatusTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pump_status (
        id SERIAL PRIMARY KEY,
        area_name TEXT UNIQUE,
        pump_id TEXT,
        status BOOLEAN DEFAULT false,
        mode TEXT DEFAULT 'auto',
        last_updated TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('Pump status table initialized successfully');
  } catch (error) {
    console.error('Pump status table initialization error:', error);
  }
}

// Initialize database on startup
initPumpStatusTable();

// Store connected clients
const clients = new Map();

// Create WebSocket server
const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws, req) => {
  const areaName = req.url.split('?area=')[1];
  console.log(`WebSocket client connected for area: ${areaName}`);
  
  // Store client connection with area name as key
  if (areaName) {
    clients.set(areaName, ws);
  }
  
  // Send initial pump status
  sendPumpStatus(areaName, ws);
  
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      console.log('Received message:', data);
      
      if (data.type === 'pump_control') {
        // Update pump status in database
        await updatePumpStatus(data.area_name, data.pump_id, data.status, data.mode);
        
        // Broadcast updated status to all connected clients for this area
        broadcastPumpStatus(data.area_name);
      } else if (data.type === 'soil_moisture_update') {
        // Handle soil moisture update from ESP32
        await handleSoilMoistureUpdate(data);
      } else if (data.type === 'request_optimal_moisture') {
        // Send optimal moisture settings to ESP32
        await sendOptimalMoisture(data.area_name, ws);
      }
    } catch (err) {
      console.error('Error processing WebSocket message:', err);
    }
  });
  
  ws.on('close', () => {
    // Remove client from connected clients
    if (areaName) {
      clients.delete(areaName);
    }
    console.log(`WebSocket client disconnected for area: ${areaName}`);
  });
});

// Handle soil moisture update from ESP32
async function handleSoilMoistureUpdate(data) {
  try {
    const { area_name, soil_moisture } = data;
    
    // Get current crop settings for this area
    const cropSettings = await pool.query(
      'SELECT * FROM crop_settings WHERE area_name = $1',
      [area_name]
    );
    
    if (cropSettings.rows.length === 0) {
      console.log(`No crop settings found for area: ${area_name}`);
      return;
    }
    
    const { optimal_moisture } = cropSettings.rows[0];
    const targetMoisture = optimal_moisture + 10; // Add 10% as requested
    
    // Get current pump status
    const pumpStatusResult = await pool.query(
      'SELECT * FROM pump_status WHERE area_name = $1',
      [area_name]
    );
    
    let pumpStatus;
    if (pumpStatusResult.rows.length === 0) {
      // Create new pump status entry if it doesn't exist
      await pool.query(
        'INSERT INTO pump_status (area_name, pump_id, status, mode) VALUES ($1, $2, $3, $4)',
        [area_name, `pump_${area_name}`, false, 'auto']
      );
      pumpStatus = { status: false, mode: 'auto' };
    } else {
      pumpStatus = pumpStatusResult.rows[0];
    }
    
    // Only control pump if in auto mode
    if (pumpStatus.mode === 'auto') {
      const newStatus = soil_moisture < targetMoisture;
      
      // Update pump status if changed
      if (newStatus !== pumpStatus.status) {
        await updatePumpStatus(area_name, `pump_${area_name}`, newStatus, 'auto');
        broadcastPumpStatus(area_name);
      }
    }
  } catch (err) {
    console.error('Error handling soil moisture update:', err);
  }
}

// Send optimal moisture settings to ESP32
async function sendOptimalMoisture(areaName, ws) {
  try {
    // Get crop settings for this area
    const cropSettings = await pool.query(
      'SELECT * FROM crop_settings WHERE area_name = $1',
      [areaName]
    );
    
    if (cropSettings.rows.length === 0) {
      ws.send(JSON.stringify({
        type: 'optimal_moisture_response',
        status: 'error',
        message: 'No crop settings found'
      }));
      return;
    }
    
    const { crop_name, optimal_moisture } = cropSettings.rows[0];
    const targetMoisture = optimal_moisture + 10; // Add 10% as requested
    
    ws.send(JSON.stringify({
      type: 'optimal_moisture_response',
      status: 'success',
      crop_name,
      optimal_moisture,
      target_moisture: targetMoisture
    }));
  } catch (err) {
    console.error('Error sending optimal moisture settings:', err);
    ws.send(JSON.stringify({
      type: 'optimal_moisture_response',
      status: 'error',
      message: 'Database error'
    }));
  }
}

// Update pump status in database
async function updatePumpStatus(areaName, pumpId, status, mode) {
  try {
    await pool.query(`
      INSERT INTO pump_status (area_name, pump_id, status, mode, last_updated)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (area_name)
      DO UPDATE SET status = $3, mode = $4, last_updated = NOW()
    `, [areaName, pumpId, status, mode]);
    
    console.log(`Pump ${pumpId} in area ${areaName} ${status ? 'turned ON' : 'turned OFF'} in ${mode} mode`);
    return true;
  } catch (err) {
    console.error('Error updating pump status:', err);
    return false;
  }
}

// Send pump status to client
async function sendPumpStatus(areaName, ws) {
  try {
    const result = await pool.query(
      'SELECT * FROM pump_status WHERE area_name = $1',
      [areaName]
    );
    
    let pumpStatus;
    if (result.rows.length === 0) {
      pumpStatus = {
        area_name: areaName,
        pump_id: `pump_${areaName}`,
        status: false,
        mode: 'auto',
        last_updated: new Date()
      };
    } else {
      pumpStatus = result.rows[0];
    }
    
    ws.send(JSON.stringify({
      type: 'pump_status_update',
      ...pumpStatus
    }));
  } catch (err) {
    console.error('Error sending pump status:', err);
  }
}

// Broadcast pump status to all connected clients for an area
async function broadcastPumpStatus(areaName) {
  try {
    const result = await pool.query(
      'SELECT * FROM pump_status WHERE area_name = $1',
      [areaName]
    );
    
    if (result.rows.length === 0) {
      return;
    }
    
    const pumpStatus = result.rows[0];
    const ws = clients.get(areaName);
    
    if (ws && ws.readyState === 1) { // 1 = OPEN
      ws.send(JSON.stringify({
        type: 'pump_status_update',
        ...pumpStatus
      }));
    }
  } catch (err) {
    console.error('Error broadcasting pump status:', err);
  }
}

// REST endpoints for pump control
app.use(express.json());

// Get all pump statuses
app.get('/api/pumps', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM pump_status ORDER BY area_name');
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching pump statuses:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Get pump status for specific area
app.get('/api/pumps/:area_name', async (req, res) => {
  const { area_name } = req.params;
  
  try {
    const result = await pool.query(
      'SELECT * FROM pump_status WHERE area_name = $1',
      [area_name]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No pump found for this area' });
    }
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching pump status:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Control pump for specific area
app.post('/api/pumps/:area_name', async (req, res) => {
  const { area_name } = req.params;
  const { status, mode } = req.body;
  
  if (status === undefined || !mode) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  try {
    const success = await updatePumpStatus(area_name, `pump_${area_name}`, status, mode);
    
    if (success) {
      // Broadcast updated status
      broadcastPumpStatus(area_name);
      res.json({ success: true, message: 'Pump status updated successfully' });
    } else {
      res.status(500).json({ error: 'Failed to update pump status' });
    }
  } catch (err) {
    console.error('Error updating pump status:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Start server
const server = app.listen(port, () => {
  console.log(`Pump control server running on http://localhost:${port}`);
});

// Handle WebSocket upgrade
server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, socket => {
    wss.emit('connection', socket, request);
  });
});

export default server;
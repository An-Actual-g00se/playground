const express = require('express');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Pool } = require('pg');

const app = express();
const port = Number(process.env.PORT || 3000);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://traceability:traceability@localhost:5432/traceability',
});

app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/locations', async (request, response, next) => {
  try {
    const result = await pool.query(`
      SELECT id, name, address, zip_code AS "zipCode", facility_type AS "facilityType",
             latitude, longitude
      FROM locations
      ORDER BY name
    `);
    response.json(result.rows);
  } catch (error) {
    next(error);
  }
});

app.post('/api/locations', async (request, response, next) => {
  try {
    const { name, address, zipCode, facilityType, latitude, longitude } = request.body;
    const lat = Number(latitude);
    const lon = Number(longitude);
    if (![name, address, zipCode, facilityType].every((value) => typeof value === 'string' && value.trim()) ||
        !Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) {
      return response.status(400).json({ error: 'Enter all location details and valid coordinates.' });
    }

    const result = await pool.query(`
      INSERT INTO locations (name, address, zip_code, facility_type, latitude, longitude)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, name, address, zip_code AS "zipCode", facility_type AS "facilityType", latitude, longitude
    `, [name.trim(), address.trim(), zipCode.trim(), facilityType.trim(), lat, lon]);
    response.status(201).json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') {
      return response.status(409).json({ error: 'A location with that name and address already exists.' });
    }
    next(error);
  }
});

app.get('/api/routes', async (request, response, next) => {
  try {
    const result = await pool.query(`
      SELECT r.id, r.name, r.created_at AS "createdAt",
             COALESCE(
               json_agg(json_build_object(
                 'id', l.id,
                 'name', l.name,
                 'address', l.address,
                 'zipCode', l.zip_code,
                 'facilityType', l.facility_type,
                 'latitude', l.latitude,
                 'longitude', l.longitude,
                 'stopOrder', rs.stop_order
               ) ORDER BY rs.stop_order) FILTER (WHERE l.id IS NOT NULL),
               '[]'::json
             ) AS stops
      FROM routes r
      LEFT JOIN route_stops rs ON rs.route_id = r.id
      LEFT JOIN locations l ON l.id = rs.location_id
      GROUP BY r.id
      ORDER BY r.created_at DESC, r.id DESC
    `);
    response.json(result.rows);
  } catch (error) {
    next(error);
  }
});

app.post('/api/routes', async (request, response, next) => {
  const name = typeof request.body.name === 'string' ? request.body.name.trim() : '';
  const locationIds = request.body.locationIds;
  if (!name || !Array.isArray(locationIds) || locationIds.length < 2 ||
      locationIds.some((id) => !Number.isInteger(Number(id))) ||
      new Set(locationIds.map(Number)).size !== locationIds.length) {
    return response.status(400).json({ error: 'Provide a route name and at least two distinct locations in order.' });
  }

  const client = await pool.connect();
  try {
    const ids = locationIds.map(Number);
    const locations = await client.query(
      'SELECT id FROM locations WHERE id = ANY($1::bigint[])', [ids],
    );
    if (locations.rowCount !== ids.length) {
      return response.status(400).json({ error: 'One or more selected locations no longer exist.' });
    }

    await client.query('BEGIN');
    const routeResult = await client.query(
      'INSERT INTO routes (name) VALUES ($1) RETURNING id', [name],
    );
    const routeId = routeResult.rows[0].id;
    for (const [index, locationId] of ids.entries()) {
      await client.query(
        'INSERT INTO route_stops (route_id, location_id, stop_order) VALUES ($1, $2, $3)',
        [routeId, locationId, index + 1],
      );
    }
    await client.query('COMMIT');
    response.status(201).json({ id: routeId });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

app.put('/api/routes/:routeId/stops', async (request, response, next) => {
  const routeId = Number(request.params.routeId);
  const locationIds = request.body.locationIds;
  if (!Number.isInteger(routeId) || !Array.isArray(locationIds) || locationIds.length < 2 ||
      locationIds.some((id) => !Number.isInteger(Number(id))) ||
      new Set(locationIds.map(Number)).size !== locationIds.length) {
    return response.status(400).json({ error: 'Provide the route stops in a valid order.' });
  }

  const client = await pool.connect();
  try {
    const ids = locationIds.map(Number);
    await client.query('BEGIN');
    const current = await client.query(
      'SELECT location_id, stop_order FROM route_stops WHERE route_id = $1 FOR UPDATE', [routeId],
    );
    const currentIds = current.rows.map((row) => Number(row.location_id));
    if (currentIds.length !== ids.length || ids.some((id) => !currentIds.includes(id))) {
      await client.query('ROLLBACK');
      return response.status(400).json({ error: 'Reordering must include every existing stop exactly once.' });
    }

    const orderOffset = Math.max(...current.rows.map((row) => Number(row.stop_order))) + ids.length + 1;
    await client.query(
      'UPDATE route_stops SET stop_order = stop_order + $2 WHERE route_id = $1',
      [routeId, orderOffset],
    );
    for (const [index, locationId] of ids.entries()) {
      await client.query(
        'UPDATE route_stops SET stop_order = $3 WHERE route_id = $1 AND location_id = $2',
        [routeId, locationId, index + 1],
      );
    }
    await client.query('COMMIT');
    response.json({ id: routeId, locationIds: ids });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

app.use((error, request, response, next) => {
  console.error(error);
  if (response.headersSent) return next(error);
  response.status(500).json({ error: 'The server could not complete the request.' });
});

async function start() {
  const schema = await fs.readFile(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);
  app.listen(port, () => console.log(`Traceability route map listening on http://localhost:${port}`));
}

start().catch((error) => {
  console.error('Could not start the server. Check that PostgreSQL is running and DATABASE_URL is correct.', error);
  process.exitCode = 1;
});
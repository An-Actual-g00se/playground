const express = require('express');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Pool } = require('pg');

const app = express();
const port = Number(process.env.PORT || 3000);
const osmTileUrl = process.env.OSM_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const osmTileUserAgent = process.env.OSM_TILE_USER_AGENT ||
  'TraceabilityRouteMap/1.0 (+https://github.com/An-Actual-g00se/playground)';
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://traceability:traceability@localhost:5432/traceability',
});

app.use(express.json({ limit: '32kb' }));
app.get('/tiles/:zoom/:x/:y.png', async (request, response, next) => {
  const { zoom, x, y } = request.params;
  if (![zoom, x, y].every((value) => /^\d+$/.test(value))) {
    return response.status(400).json({ error: 'Invalid tile coordinates.' });
  }

  const [zoomLevel, tileX, tileY] = [zoom, x, y].map(Number);
  const tilesAtZoom = 2 ** zoomLevel;
  if (zoomLevel > 19 || tileX >= tilesAtZoom || tileY >= tilesAtZoom) {
    return response.status(400).json({ error: 'Tile coordinates are outside the supported range.' });
  }

  const referer = request.get('referer');
  if (!referer) {
    return response.status(400).json({ error: 'A browser Referer is required for OSM tile requests.' });
  }

  try {
    const tileUrl = osmTileUrl
      .replace('{z}', String(zoomLevel))
      .replace('{x}', String(tileX))
      .replace('{y}', String(tileY));
    const headers = new Headers({ 'User-Agent': osmTileUserAgent, Referer: referer });
    for (const headerName of ['if-none-match', 'if-modified-since']) {
      const value = request.get(headerName);
      if (value) headers.set(headerName, value);
    }

    const tileResponse = await fetch(tileUrl, { headers });
    for (const headerName of ['cache-control', 'expires', 'etag', 'last-modified', 'content-type', 'retry-after', 'x-blocked']) {
      const value = tileResponse.headers.get(headerName);
      if (value) response.set(headerName, value);
    }
    response.status(tileResponse.status);
    if (tileResponse.status === 304 || tileResponse.status === 204) return response.end();
    response.send(Buffer.from(await tileResponse.arrayBuffer()));
  } catch (error) {
    next(error);
  }
});
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

function normalizeTimestamp(value, fieldName) {
  if (value === null || value === undefined || value === '') return { value: null };
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    return { error: `${fieldName} must be an ISO timestamp with a timezone.` };
  }

  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) {
    return { error: `${fieldName} must be a valid date and time.` };
  }
  return { value: timestamp.toISOString() };
}

function normalizeRouteStops(stops) {
  if (!Array.isArray(stops) || stops.length < 2) {
    return { error: 'Provide at least two stops in visit order.' };
  }

  const seenLocationIds = new Set();
  const normalizedStops = [];
  for (const stop of stops) {
    const locationId = Number(stop?.locationId);
    if (!Number.isInteger(locationId) || locationId <= 0 || seenLocationIds.has(locationId)) {
      return { error: 'Each stop must have a unique valid location ID.' };
    }
    seenLocationIds.add(locationId);

    const arrival = normalizeTimestamp(stop.arrivalAt, 'Arrival');
    const departure = normalizeTimestamp(stop.departureAt, 'Departure');
    if (arrival.error) return arrival;
    if (departure.error) return departure;
    if (arrival.value && departure.value && Date.parse(arrival.value) > Date.parse(departure.value)) {
      return { error: 'Arrival must be before or at departure for each stop.' };
    }

    normalizedStops.push({ locationId, arrivalAt: arrival.value, departureAt: departure.value });
  }
  return { stops: normalizedStops };
}

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
                 'stopOrder', rs.stop_order,
                 'arrivalAt', rs.arrival_at,
                 'departureAt', rs.departure_at
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
  const schedule = normalizeRouteStops(request.body.stops);
  if (!name || schedule.error) {
    return response.status(400).json({ error: schedule.error || 'Provide a route name.' });
  }

  const client = await pool.connect();
  try {
    const ids = schedule.stops.map((stop) => stop.locationId);
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
    for (const [index, stop] of schedule.stops.entries()) {
      await client.query(
        `INSERT INTO route_stops
          (route_id, location_id, stop_order, arrival_at, departure_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [routeId, stop.locationId, index + 1, stop.arrivalAt, stop.departureAt],
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
  const schedule = normalizeRouteStops(request.body.stops);
  if (!Number.isInteger(routeId) || routeId <= 0 || schedule.error) {
    return response.status(400).json({ error: 'Provide the route stops in a valid order.' });
  }

  const client = await pool.connect();
  try {
    const ids = schedule.stops.map((stop) => stop.locationId);
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
    for (const [index, stop] of schedule.stops.entries()) {
      await client.query(
        `UPDATE route_stops
         SET stop_order = $3, arrival_at = $4, departure_at = $5
         WHERE route_id = $1 AND location_id = $2`,
        [routeId, stop.locationId, index + 1, stop.arrivalAt, stop.departureAt],
      );
    }
    await client.query('COMMIT');
    response.json({ id: routeId, stops: schedule.stops });
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
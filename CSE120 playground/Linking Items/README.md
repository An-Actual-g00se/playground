## Constraints

- General employees access the workflow by scanning a QR code.
- Employees can add data to a linked list or end the list and insert the finalized list into a database.
- A custom class stores the source of each item, the item itself, and the time it was added.

## Criteria

- General consumers can view the finalized list in a clear format.
- The list displays a timestamp for when each item was added.

## Traceability Route Map

This folder also contains a PostgreSQL-backed location and route planner. It stores facility names, street addresses, ZIP codes, facility types, and coordinates. Routes save their stops in an explicit order; the Leaflet map displays each facility and requests driving geometry from OSRM in that order.

### Run locally

1. Start PostgreSQL with Docker Compose:

	```sh
	docker compose up -d database
	```

2. Install the Node.js dependencies and start the app:

	```sh
	npm install
	npm start
	```

3. Open [http://localhost:3000](http://localhost:3000).

The default database connection matches `docker-compose.yml`. Set `DATABASE_URL` to use another PostgreSQL instance, or `PORT` to change the web server port. The server applies `schema.sql` at startup, and the schema includes sample Seattle facilities. Leaflet tiles and OSRM routing require an internet connection. The default OSRM URL in `public/app.js` uses the shared demo service, which can be rate-limited; replace it with your own OSRM instance for production.
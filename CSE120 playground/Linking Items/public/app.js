const map = L.map('map', { zoomControl: false }).setView([47.61, -122.337], 12);
const osrmBaseUrl = 'https://router.project-osrm.org';
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.tileLayer('/tiles/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
}).addTo(map);

const locationsById = new Map();
const markersById = new Map();
const scheduleByLocationId = new Map();
let locations = [];
let selectedIds = [];
let activeRouteId = null;
let routeLine;
let routeRequestId = 0;
let savedRoutes = [];

const elements = {
  connection: document.querySelector('#connection-status'),
  locationCount: document.querySelector('#location-count'),
  locationList: document.querySelector('#location-list'),
  routeName: document.querySelector('#route-name'),
  saveRoute: document.querySelector('#save-route'),
  stopList: document.querySelector('#stop-list'),
  stopCount: document.querySelector('#stop-count'),
  sequenceEmpty: document.querySelector('#sequence-empty'),
  routeFeedback: document.querySelector('#route-feedback'),
  savedRoutes: document.querySelector('#saved-routes'),
  mapTitle: document.querySelector('#map-title'),
  mapSubtitle: document.querySelector('#map-subtitle'),
  locationForm: document.querySelector('#location-form'),
};

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function timestampToLocalInput(value) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function localInputToTimestamp(value) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Enter a valid arrival and departure date/time.');
  return date.toISOString();
}

function formatPopupScheduleTime(value) {
  if (!value) return 'Not set';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Not set';
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function loadScheduleFromStops(stops) {
  scheduleByLocationId.clear();
  for (const stop of stops) {
    scheduleByLocationId.set(Number(stop.id), {
      arrivalLocal: timestampToLocalInput(stop.arrivalAt),
      departureLocal: timestampToLocalInput(stop.departureAt),
    });
  }
}

function buildScheduledStops() {
  return selectedIds.map((locationId) => {
    const schedule = scheduleByLocationId.get(locationId) || {};
    const arrivalAt = localInputToTimestamp(schedule.arrivalLocal);
    const departureAt = localInputToTimestamp(schedule.departureLocal);
    if (arrivalAt && departureAt && Date.parse(arrivalAt) > Date.parse(departureAt)) {
      throw new Error('Arrival must be before or at departure for each stop.');
    }
    return { locationId, arrivalAt, departureAt };
  });
}

async function request(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'The request could not be completed.');
  return body;
}

function popupContent(location) {
  const locationId = Number(location.id);
  const schedule = selectedIds.includes(locationId) ? scheduleByLocationId.get(locationId) : null;
  const scheduleContent = schedule
    ? `<br><br><strong>Route schedule (local time)</strong><br>Arrival: ${escapeHtml(formatPopupScheduleTime(schedule.arrivalLocal))}<br>Departure: ${escapeHtml(formatPopupScheduleTime(schedule.departureLocal))}`
    : '';
  return `<strong>${escapeHtml(location.name)}</strong><br>${escapeHtml(location.address)}<br>${escapeHtml(location.zipCode)} · ${escapeHtml(location.facilityType)}${scheduleContent}`;
}

function markerIcon(number) {
  const className = number ? 'map-marker map-marker--selected' : 'map-marker';
  const label = number ? `<span>${number}</span>` : '<span class="marker-center"></span>';
  return L.divIcon({ className: '', html: `<div class="${className}">${label}</div>`, iconSize: [30, 38], iconAnchor: [15, 34], popupAnchor: [0, -32] });
}

function refreshMarkers() {
  const sequenceNumbers = new Map(selectedIds.map((id, index) => [id, index + 1]));
  for (const location of locations) {
    const marker = markersById.get(location.id);
    if (marker) {
      marker.setIcon(markerIcon(sequenceNumbers.get(location.id)));
      marker.setPopupContent(popupContent(location));
    }
  }
}

function renderLocations() {
  elements.locationCount.textContent = locations.length;
  elements.locationList.innerHTML = locations.map((location) => {
    const added = selectedIds.includes(location.id);
    const canAdd = !activeRouteId;
    return `<article class="location-item">
      <span class="facility-symbol" aria-hidden="true">${escapeHtml(location.facilityType.slice(0, 1).toUpperCase())}</span>
      <button class="location-details" type="button" data-focus="${location.id}" aria-label="Show ${escapeHtml(location.name)} on map">
        <strong>${escapeHtml(location.name)}</strong><span>${escapeHtml(location.address)}</span><small>${escapeHtml(location.zipCode)} <i>·</i> ${escapeHtml(location.facilityType)}</small>
      </button>
      <button class="add-stop-button ${added ? 'is-added' : ''}" type="button" data-add="${location.id}" aria-label="${added ? 'Remove' : 'Add'} ${escapeHtml(location.name)} ${added ? 'from' : 'to'} route" title="${added ? 'Remove from route' : 'Add to route'}" ${canAdd ? '' : 'disabled'}>${added ? '−' : '+'}</button>
    </article>`;
  }).join('');
  refreshMarkers();
}

function renderStops() {
  elements.stopCount.textContent = `${selectedIds.length} ${selectedIds.length === 1 ? 'stop' : 'stops'}`;
  elements.sequenceEmpty.hidden = selectedIds.length > 0;
  elements.stopList.innerHTML = selectedIds.map((id, index) => {
    const location = locationsById.get(id);
    if (!location) return '';
    const schedule = scheduleByLocationId.get(id) || { arrivalLocal: '', departureLocal: '' };
    return `<li class="stop-item">
      <span class="stop-number">${index + 1}</span>
      <span class="stop-name">${escapeHtml(location.name)}</span>
      <div class="stop-schedule">
        <label>Arrival
          <input type="datetime-local" data-schedule-location="${id}" data-schedule-field="arrivalLocal" value="${escapeHtml(schedule.arrivalLocal)}" aria-label="Arrival date and time at ${escapeHtml(location.name)}">
        </label>
        <label>Departure
          <input type="datetime-local" data-schedule-location="${id}" data-schedule-field="departureLocal" value="${escapeHtml(schedule.departureLocal)}" aria-label="Departure date and time at ${escapeHtml(location.name)}">
        </label>
      </div>
      <span class="stop-actions">
        <button type="button" data-move="${index}" data-direction="-1" aria-label="Move ${escapeHtml(location.name)} up" title="Move up" ${index === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" data-move="${index}" data-direction="1" aria-label="Move ${escapeHtml(location.name)} down" title="Move down" ${index === selectedIds.length - 1 ? 'disabled' : ''}>↓</button>
        <button type="button" data-remove="${id}" aria-label="Remove ${escapeHtml(location.name)} from route" title="Remove stop" ${activeRouteId ? 'disabled' : ''}>×</button>
      </span>
    </li>`;
  }).join('');
  elements.saveRoute.disabled = selectedIds.length < 2;
  elements.saveRoute.textContent = activeRouteId ? 'Save order' : 'Save route';
  elements.routeName.disabled = Boolean(activeRouteId);
  renderLocations();
}

function drawStops(stops, title, shouldRequestRoute = true) {
  routeRequestId += 1;
  const thisRequest = routeRequestId;
  if (routeLine) map.removeLayer(routeLine);
  const normalizedStops = stops.map((stop) => ({ ...stop, id: Number(stop.id) }));
  selectedIds = normalizedStops.map((stop) => stop.id);
  renderStops();
  elements.mapTitle.textContent = title;
  elements.mapSubtitle.textContent = `${normalizedStops.length} ${normalizedStops.length === 1 ? 'location' : 'locations'} in visit order`;

  const points = normalizedStops.map((stop) => [Number(stop.latitude), Number(stop.longitude)]);
  const allPoints = locations.map((location) => [Number(location.latitude), Number(location.longitude)]);
  if (points.length) map.fitBounds(L.latLngBounds(points), { padding: [48, 48], maxZoom: 14 });
  else if (allPoints.length) map.fitBounds(L.latLngBounds(allPoints), { padding: [48, 48], maxZoom: 14 });

  if (!shouldRequestRoute || points.length < 2) {
    elements.routeFeedback.textContent = '';
    return;
  }

  const coordinates = normalizedStops.map((stop) => `${stop.longitude},${stop.latitude}`).join(';');
  const url = `${osrmBaseUrl}/route/v1/driving/${coordinates}?overview=full&geometries=geojson&steps=false`;
  fetch(url).then((response) => {
    if (!response.ok) throw new Error('Routing service unavailable');
    return response.json();
  }).then((data) => {
    if (thisRequest !== routeRequestId) return;
    if (data.code !== 'Ok' || !data.routes?.[0]?.geometry) throw new Error('No drivable route found');
    routeLine = L.geoJSON(data.routes[0].geometry, {
      style: { color: '#d35e3f', weight: 5, opacity: 0.88, lineCap: 'round', lineJoin: 'round' },
    }).addTo(map);
    map.fitBounds(routeLine.getBounds().extend(L.latLngBounds(points)), { padding: [48, 48], maxZoom: 14 });
    elements.routeFeedback.textContent = `${(data.routes[0].distance / 1000).toFixed(1)} km · ${(data.routes[0].duration / 60).toFixed(0)} min estimated`;
  }).catch(() => {
    if (thisRequest === routeRequestId) elements.routeFeedback.textContent = 'Route line unavailable. Check the OSRM service; stop markers remain visible.';
  });
}

async function loadRoutes() {
  savedRoutes = await request('/api/routes');
  elements.savedRoutes.innerHTML = '<option value="">Choose a route</option>' + savedRoutes.map((route) =>
    `<option value="${route.id}">${escapeHtml(route.name)}</option>`).join('');
}

async function loadLocations() {
  locations = await request('/api/locations');
  locationsById.clear();
  markersById.clear();
  for (const location of locations) {
    location.id = Number(location.id);
    locationsById.set(location.id, location);
    const marker = L.marker([location.latitude, location.longitude], { icon: markerIcon() }).addTo(map);
    marker.bindPopup(popupContent(location));
    markersById.set(location.id, marker);
  }
  renderStops();
  if (locations.length) {
    map.fitBounds(L.latLngBounds(locations.map((location) => [location.latitude, location.longitude])), { padding: [48, 48], maxZoom: 14 });
  }
}

elements.locationList.addEventListener('click', (event) => {
  const addButton = event.target.closest('[data-add]');
  const focusButton = event.target.closest('[data-focus]');
  if (addButton && !addButton.disabled) {
    const id = Number(addButton.dataset.add);
    if (selectedIds.includes(id)) {
      selectedIds = selectedIds.filter((stopId) => stopId !== id);
      scheduleByLocationId.delete(id);
    } else {
      selectedIds = [...selectedIds, id];
    }
    renderStops();
  }
  if (focusButton) {
    const location = locationsById.get(Number(focusButton.dataset.focus));
    map.setView([location.latitude, location.longitude], 15);
    markersById.get(location.id).openPopup();
  }
});

// TODO: ARRIVAL/DEPARTURE SCHEDULE input/change handling belongs on this delegated stop-list listener.
elements.stopList.addEventListener('click', (event) => {
  const moveButton = event.target.closest('[data-move]');
  const removeButton = event.target.closest('[data-remove]');
  if (moveButton) {
    const index = Number(moveButton.dataset.move);
    const target = index + Number(moveButton.dataset.direction);
    if (target >= 0 && target < selectedIds.length) {
      [selectedIds[index], selectedIds[target]] = [selectedIds[target], selectedIds[index]];
      renderStops();
      if (activeRouteId) {
        const route = savedRoutes.find((item) => String(item.id) === String(activeRouteId));
        drawStops(selectedIds.map((id) => locationsById.get(id)), route.name, true);
        elements.routeFeedback.textContent = 'Order changed. Save order to update this route.';
      }
    }
  }
  if (removeButton && !activeRouteId) {
    selectedIds = selectedIds.filter((id) => id !== Number(removeButton.dataset.remove));
    renderStops();
  }
});

elements.stopList.addEventListener('input', (event) => {
  const input = event.target.closest('[data-schedule-location][data-schedule-field]');
  if (!input) return;

  const locationId = Number(input.dataset.scheduleLocation);
  const field = input.dataset.scheduleField;
  if (!['arrivalLocal', 'departureLocal'].includes(field)) return;

  const schedule = scheduleByLocationId.get(locationId) || { arrivalLocal: '', departureLocal: '' };
  schedule[field] = input.value;
  scheduleByLocationId.set(locationId, schedule);
  const location = locationsById.get(locationId);
  const marker = markersById.get(locationId);
  if (location && marker) marker.setPopupContent(popupContent(location));
});

elements.saveRoute.addEventListener('click', async () => {
  elements.routeFeedback.textContent = '';
  try {
    const stops = buildScheduledStops();
    if (activeRouteId) {
      await request(`/api/routes/${activeRouteId}/stops`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stops }),
      });
      await loadRoutes();
      elements.savedRoutes.value = activeRouteId;
      const route = savedRoutes.find((item) => String(item.id) === String(activeRouteId));
      loadScheduleFromStops(route.stops);
      drawStops(route.stops, route.name);
      elements.routeFeedback.textContent = 'Saved order updated.';
      return;
    }

    const name = elements.routeName.value.trim();
    const route = await request('/api/routes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, stops }),
    });
    await loadRoutes();
    activeRouteId = route.id;
    elements.savedRoutes.value = route.id;
    elements.routeName.value = name;
    const savedRoute = savedRoutes.find((item) => String(item.id) === String(route.id));
    loadScheduleFromStops(savedRoute.stops);
    drawStops(savedRoute.stops, name);
  } catch (error) {
    elements.routeFeedback.textContent = error.message;
  }
});

elements.savedRoutes.addEventListener('change', () => {
  const route = savedRoutes.find((item) => String(item.id) === elements.savedRoutes.value);
  activeRouteId = route?.id ?? null;
  if (route) {
    elements.routeName.value = route.name;
    loadScheduleFromStops(route.stops);
    drawStops(route.stops, route.name);
    return;
  }

  routeRequestId += 1;
  if (routeLine) map.removeLayer(routeLine);
  routeLine = undefined;
  selectedIds = [];
  scheduleByLocationId.clear();
  elements.routeName.value = '';
  renderStops();
  elements.mapTitle.textContent = 'All facilities';
  elements.mapSubtitle.textContent = 'Select locations to plan a route';
  elements.routeFeedback.textContent = '';
  if (locations.length) map.fitBounds(L.latLngBounds(locations.map((location) => [location.latitude, location.longitude])), { padding: [48, 48], maxZoom: 14 });
});

elements.locationForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const payload = Object.fromEntries(new FormData(elements.locationForm).entries());
  payload.latitude = Number(payload.latitude);
  payload.longitude = Number(payload.longitude);
  try {
    const location = await request('/api/locations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    elements.locationForm.reset();
    location.id = Number(location.id);
    locations.push(location);
    locations.sort((first, second) => first.name.localeCompare(second.name));
    locationsById.set(location.id, location);
    const marker = L.marker([location.latitude, location.longitude], { icon: markerIcon() }).addTo(map);
    marker.bindPopup(popupContent(location));
    markersById.set(location.id, marker);
    renderStops();
    map.setView([location.latitude, location.longitude], 14);
    elements.routeFeedback.textContent = 'Location saved.';
  } catch (error) {
    elements.routeFeedback.textContent = error.message;
  }
});

Promise.all([loadLocations(), loadRoutes()]).then(() => {
  elements.connection.textContent = 'PostgreSQL connected';
  document.querySelector('.system-status').classList.add('is-connected');
}).catch((error) => {
  elements.connection.textContent = 'Database unavailable';
  elements.routeFeedback.textContent = error.message;
});

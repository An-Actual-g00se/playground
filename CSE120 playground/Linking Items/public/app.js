const map = L.map('map', { zoomControl: false }).setView([47.61, -122.337], 12);
const osrmBaseUrl = 'https://router.project-osrm.org';
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.tileLayer('map key here', {
  subdomains: 'abcd',
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
}).addTo(map);

const locationsById = new Map();
const markersById = new Map();
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

async function request(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'The request could not be completed.');
  return body;
}

function popupContent(location) {
  return `<strong>${escapeHtml(location.name)}</strong><br>${escapeHtml(location.address)}<br>${escapeHtml(location.zipCode)} · ${escapeHtml(location.facilityType)}`;
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
    return `<li class="stop-item">
      <span class="stop-number">${index + 1}</span>
      <span class="stop-name">${escapeHtml(location.name)}</span>
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
    selectedIds = selectedIds.includes(id) ? selectedIds.filter((stopId) => stopId !== id) : [...selectedIds, id];
    renderStops();
  }
  if (focusButton) {
    const location = locationsById.get(Number(focusButton.dataset.focus));
    map.setView([location.latitude, location.longitude], 15);
    markersById.get(location.id).openPopup();
  }
});

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

elements.saveRoute.addEventListener('click', async () => {
  elements.routeFeedback.textContent = '';
  try {
    if (activeRouteId) {
      await request(`/api/routes/${activeRouteId}/stops`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locationIds: selectedIds }),
      });
      await loadRoutes();
      elements.savedRoutes.value = activeRouteId;
      const route = savedRoutes.find((item) => String(item.id) === String(activeRouteId));
      drawStops(route.stops, route.name);
      elements.routeFeedback.textContent = 'Saved order updated.';
      return;
    }

    const name = elements.routeName.value.trim();
    const route = await request('/api/routes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, locationIds: selectedIds }),
    });
    await loadRoutes();
    activeRouteId = route.id;
    elements.savedRoutes.value = route.id;
    elements.routeName.value = name;
    drawStops(selectedIds.map((id) => locationsById.get(id)), name);
  } catch (error) {
    elements.routeFeedback.textContent = error.message;
  }
});

elements.savedRoutes.addEventListener('change', () => {
  const route = savedRoutes.find((item) => String(item.id) === elements.savedRoutes.value);
  activeRouteId = route?.id ?? null;
  if (route) {
    elements.routeName.value = route.name;
    drawStops(route.stops, route.name);
    return;
  }

  routeRequestId += 1;
  if (routeLine) map.removeLayer(routeLine);
  routeLine = undefined;
  selectedIds = [];
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

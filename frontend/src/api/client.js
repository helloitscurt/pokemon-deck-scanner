import axios from 'axios'
import { isPublicSharePath } from '../utils/publicRoutes'

const api = axios.create({
  baseURL: '/api',
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
})

api.interceptors.request.use((config) => {
  if (config.skipAuthentication) return config

  const token = localStorage.getItem('token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401 && !error.config?.preserveSessionOnUnauthorized) {
      const token = localStorage.getItem('token')
      localStorage.removeItem('token')
      localStorage.removeItem('user')
      if (token && window.location.pathname !== '/login' && !isPublicSharePath(window.location.pathname)) {
        window.location.href = '/login'
      }
    }
    return Promise.reject(error)
  }
)

export const login = (username, password) => {
  const params = new URLSearchParams()
  params.append('username', username)
  params.append('password', password)
  return api.post('/auth/login', params, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  }).then(r => r.data)
}

export const getMe = ({ withoutToken = false, preserveSession = false } = {}) => api.get('/auth/me', {
  skipAuthentication: withoutToken,
  preserveSessionOnUnauthorized: preserveSession,
}).then(r => r.data)
export const getAuthMode = () => api.get('/auth/mode', {
  // Mode discovery is public. A leftover token must not influence bootstrap
  // or let a transient/invalid response destroy the stored session.
  skipAuthentication: true,
  preserveSessionOnUnauthorized: true,
}).then(r => r.data)
export const setAuthMode = (enabled) => api.put('/auth/mode', { enabled }).then(r => r.data)
export const getUsers = () => api.get('/auth/users').then(r => r.data)
export const createUser = (data) => api.post('/auth/users', data).then(r => r.data)
export const updateUser = (id, data) => api.put(`/auth/users/${id}`, data).then(r => r.data)
export const deleteUser = (id) => api.delete(`/auth/users/${id}`).then(r => r.data)
export const changePassword = (data) => api.put('/auth/me/password', data).then(r => r.data)
export const forceChangePassword = (newPassword) => api.put('/auth/me/force-password', { new_password: newPassword }).then(r => r.data)
export const changeAvatar = (avatarId) => api.put('/auth/me/avatar', { avatar_id: avatarId }).then(r => r.data)
export const changeUsername = (username) => api.put('/auth/me/username', { username }).then(r => r.data)


const formatApiErrorDetail = (detail) => {
  if (!detail) return ''
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    return detail.map(formatApiErrorDetail).filter(Boolean).join('; ')
  }
  if (typeof detail === 'object') {
    const message = detail.msg || detail.message || detail.detail
    const loc = Array.isArray(detail.loc)
      ? detail.loc.filter(part => part !== 'body').join('.')
      : ''
    if (message) return loc ? `${loc}: ${formatApiErrorDetail(message)}` : formatApiErrorDetail(message)
    try {
      return JSON.stringify(detail)
    } catch {
      return ''
    }
  }
  return String(detail)
}

export const getApiErrorMessage = (error, fallback = 'Request failed') => {
  const detail = error?.response?.data?.detail ?? error?.response?.data?.message ?? error?.message
  return formatApiErrorDetail(detail) || fallback
}

// Settings
export const getTcgdexFilterLanguages = () => api.get('/settings/tcgdex-filter-languages').then(r => r.data)

// Public profile (owner controls)
export const getProfile = () => api.get('/profile/').then(r => r.data)
export const updateProfile = (data) => api.put('/profile/', data).then(r => r.data)

// Cards
export const searchCards = (params) => api.get('/cards/search', { params })
export const getCard = (id) => api.get(`/cards/${id}`)
export const getCardInLang = (cardId, lang) => api.get(`/cards/${cardId}/lang/${lang}`)
export const getPriceHistory = (id) => api.get(`/cards/${id}/price-history`)
export const createCustomCard = (data) => api.post('/cards/custom', data)
export const updateCustomCard = (cardId, data) => api.put(`/cards/custom/${cardId}`, data).then(r => r.data)
export const updateCardCustomImage = (cardId, data) => api.put(`/cards/${cardId}/custom-image`, data).then(r => r.data)
export const deleteCustomCard = (cardId) => api.delete(`/cards/custom/${cardId}`)
export const getCustomCards = () => api.get('/cards/custom')
export const cloneCustomCard = (cardId) => api.post(`/cards/custom/${cardId}/clone`).then(r => r.data)

// Card recognition via Gemini Vision. source is an optional diagnostics
// label (e.g. "live_auto_scan" vs "manual" from the deck-tracking scanner)
// — never affects matching, only which UI flow a saved trace records.
// Overrides the shared 30s default: backend/api/recognize.py retries each
// Gemini call up to 3x with exponential backoff on a transient failure
// (408/425/500/502/503/504), and there are two such calls per recognition
// (identify + visual-match verification) — under real Gemini overload a
// single recognize measured 89s end to end. 180s leaves real margin above
// that observed worst case rather than guessing.
// signal (optional AbortSignal) lets a caller actually cancel a slow
// in-flight request — see DeckCardScanner.jsx's cancelProcessing, added
// because a live Gemini overload can make this run for well over a
// minute (see the 180s timeout comment above) with no way to back out.
export const recognizeCard = (imageFile, source, signal) => {
  const formData = new FormData()
  formData.append('file', imageFile)
  if (source) formData.append('source', source)
  return api.post('/cards/recognize', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 180000,
    signal,
  }).then(r => r.data)
}

// The free, deck-scoped match tier (docs/plans/live-card-scanner.md): pHash
// the captured crop against ONLY this deck instance's still-missing cards
// — a small, already-known local list — instead of a broad TCGdex catalog
// search. numberLocal/name (both optional, from cardOcr.js) only narrow
// among that instance's own cards, never search anything broader.
// signal: see recognizeCard's comment just above. skipPhash: set by Phase
// 3's Path B (live-zoom-only scans, no full-card photo) — pHash on a
// number-only crop could land closer to the wrong candidate than to no
// candidate at all, so this skips straight to the number/name-unique
// tiers instead of relying on pHash naturally declining to match.
export const matchDeckImage = (instanceId, imageBlob, { numberLocal, name } = {}, source, signal, skipPhash) => {
  const formData = new FormData()
  formData.append('file', imageBlob)
  if (numberLocal) formData.append('number_local', numberLocal)
  if (name) formData.append('name', name)
  if (source) formData.append('source', source)
  if (skipPhash) formData.append('skip_phash', 'true')
  return api.post(`/decks/instances/${instanceId}/match-image`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    signal,
  }).then(r => r.data)
}

// Persistent background card-scan queue.
export const enqueueScanJob = (files = [], individualPositions = []) => {
  const formData = new FormData()
  files.forEach(file => formData.append('files', file))
  formData.append('individual_positions', JSON.stringify(individualPositions))
  return api.post('/cards/recognize/jobs', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  }).then(r => r.data)
}
export const getScanJobs = () => api.get('/cards/recognize/jobs').then(r => r.data)
export const getScanJob = jobId => api.get(`/cards/recognize/jobs/${jobId}`).then(r => r.data)
export const resolveScanJobItem = (jobId, itemId, cardId = null) =>
  api.post(`/cards/recognize/jobs/${jobId}/items/${itemId}/resolve`, {
    card_id: cardId,
  }).then(r => r.data)
export const retryScanJobItem = (jobId, itemId) =>
  api.post(`/cards/recognize/jobs/${jobId}/items/${itemId}/retry`).then(r => r.data)
export const deleteScanJob = jobId =>
  api.delete(`/cards/recognize/jobs/${jobId}`).then(r => r.data)
export const fetchScanJobItemImage = (jobId, itemId) =>
  api.get(`/cards/recognize/jobs/${jobId}/items/${itemId}/image`, { responseType: 'blob' })
    .then(r => URL.createObjectURL(r.data))
// Raw Blob rather than an object URL — for handing the scanned photo off to
// uploadCollectionItemPhoto when a match is confirmed, not for display.
export const fetchScanJobItemImageBlob = (jobId, itemId) =>
  api.get(`/cards/recognize/jobs/${jobId}/items/${itemId}/image`, { responseType: 'blob' })
    .then(r => r.data)

// Custom card migration
export const getCustomMatches = () => api.get('/cards/custom/matches')
export const migrateCustomCard = (matchId) => api.post(`/cards/custom/migrate/${matchId}`)
export const dismissCustomMatch = (matchId) => api.post(`/cards/custom/dismiss/${matchId}`)

// Collection
export const getCollection = (params) => api.get('/collection/', { params })
export const getUserCollection = (userId, params = {}) => api.get(`/collection/user/${userId}`, { params }).then(r => r.data)
export const searchCollection = (params) => api.get('/collection/', { params })
export const addToCollection = (data) => api.post('/collection/', data)

// The owner's own photo of a card the catalogue has no scan of. A blob rather
// than an <img src>: unlike /api/images this endpoint is authenticated, because
// the photo belongs to the collector and not to the shared card catalogue.
// Returns the Blob — callers make and revoke their own object URLs, so the
// bytes can be cached once and rendered in several places.
export const fetchCollectionItemPhoto = (itemId) =>
  api.get(`/collection/${itemId}/photo`, { responseType: 'blob' }).then(r => r.data)

// For cards collected before the scanner kept photos, added by hand, or scanned
// and resolved earlier — resolve discards the photo, so there is otherwise no
// way to give those a picture. The backend strips EXIF and bounds the size.
export const uploadCollectionItemPhoto = (itemId, file) => {
  const form = new FormData()
  form.append('file', file)
  // The header is required, not decoration: this client defaults every request
  // to application/json, so without the override the multipart body is sent
  // under the wrong content type and the server rejects it as a missing field.
  return api.post(`/collection/${itemId}/photo`, form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  }).then(r => r.data)
}

export const deleteCollectionItemPhoto = (itemId) =>
  api.delete(`/collection/${itemId}/photo`).then(r => r.data)

export const deleteAllCollectionCardPhotos = () =>
  api.delete('/settings/card-photos').then(r => r.data)

export const bulkAddToCollection = (items) => api.post('/collection/bulk-add', { items }).then(r => r.data)
export const importCollectionCsv = (file) => {
  const formData = new FormData()
  formData.append('file', file)
  return api.post('/collection/import-csv', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  }).then(r => r.data)
}
export const updateCollectionItem = (id, data) => api.put(`/collection/${id}`, data)
export const removeFromCollection = (id) => api.delete(`/collection/${id}`)
export const getCollectionStats = (params = {}) => api.get('/collection/stats/summary', { params })

// Sets
export const getSets = (params) => api.get('/sets/', { params })
export const getSet = (id) => api.get(`/sets/${id}`)
export const getSetChecklist = (id) => api.get(`/sets/${id}/checklist`)
export const getNewSets = () => api.get('/sets/new')
export const markSetsSeen = (setIds) => api.post('/sets/mark-seen', Array.isArray(setIds) ? { set_ids: setIds } : undefined)

// Wishlist
export const getWishlist = () => api.get('/wishlist/')
export const addToWishlist = (data) => api.post('/wishlist/', data)
export const updateWishlistItem = (id, data) => api.put(`/wishlist/${id}`, data)
export const removeFromWishlist = (id) => api.delete(`/wishlist/${id}`)

// National Pokédex
export const getPokedex = (params = {}) => api.get('/pokedex', { params }).then(r => r.data)
export const getPokedexSpecies = (dexId, params = {}) => api.get(`/pokedex/${dexId}`, { params }).then(r => r.data)

// Binders
export const getBinders = () => api.get('/binders/')
export const createBinder = (data) => api.post('/binders/', data)
export const updateBinder = (id, data) => api.put(`/binders/${id}`, data)
export const deleteBinder = (id) => api.delete(`/binders/${id}`)
export const getBinderCards = (id, params = {}) => api.get(`/binders/${id}/cards`, { params })
export const addCardToBinder = (binderId, cardId, requiredQuantity = 1) => api.post(`/binders/${binderId}/cards`, null, { params: { card_id: cardId, required_quantity: requiredQuantity } })
export const addCollectionItemToBinder = (binderId, collectionItemId, quantity = 1) => api.post(`/binders/${binderId}/collection-items`, null, { params: { collection_item_id: collectionItemId, quantity } })
export const addOwnedSetToBinder = (binderId, setId) => api.post(`/binders/${binderId}/add-owned-set?set_id=${encodeURIComponent(setId)}`).then(r => r.data)
export const addOwnedSetToAutoBinder = (setId) => api.post(`/binders/add-owned-set?set_id=${encodeURIComponent(setId)}`).then(r => r.data)
export const updateBinderEntry = (binderId, binderCardId, data) => api.put(`/binders/${binderId}/entries/${binderCardId}`, data)
export const getBinderEntryEquivalentPrints = (binderId, binderCardId, params = {}) => api.get(`/binders/${binderId}/entries/${binderCardId}/equivalent-prints`, { params }).then(r => r.data)
export const getBinderPrintOptimization = (binderId, params = {}) => api.get(`/binders/${binderId}/optimize-prints`, { params }).then(r => r.data)
export const applyBinderPrintOptimization = (binderId, selectedBinderCardIds = null, params = {}) => api.post(`/binders/${binderId}/optimize-prints`, selectedBinderCardIds ? { selected_binder_card_ids: selectedBinderCardIds } : {}, { params }).then(r => r.data)
export const switchBinderEntryCard = (binderId, binderCardId, cardId, collectionItemId = null) => api.put(`/binders/${binderId}/entries/${binderCardId}/card`, { card_id: cardId, collection_item_id: collectionItemId }).then(r => r.data)
export const addBinderEntryToWishlist = (binderId, binderCardId, quantity = null) => api.post(`/binders/${binderId}/entries/${binderCardId}/wishlist`, null, { params: quantity ? { quantity } : {} }).then(r => r.data)
export const addBinderCardsToWishlist = (binderId) => api.post(`/binders/${binderId}/wishlist`).then(r => r.data)
export const convertWishlistBinderToCollection = (binderId) => api.post(`/binders/${binderId}/convert-to-collection`).then(r => r.data)
export const convertCollectionBinderToWishlist = (binderId) => api.post(`/binders/${binderId}/convert-to-wishlist`).then(r => r.data)
export const removeCardFromBinder = (binderId, cardId) => api.delete(`/binders/${binderId}/cards/${cardId}`)
export const removeBinderEntry = (binderId, binderCardId) => api.delete(`/binders/${binderId}/entries/${binderCardId}`)
export const importBinderCsv = (binderId, file) => {
  const formData = new FormData()
  formData.append('file', file)
  return api.post(`/binders/${binderId}/import-csv`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  }).then(r => r.data)
}
export const exportBinderCsv = (binderId) => {
  const token = localStorage.getItem('token')
  const config = { responseType: 'blob' }
  if (token) config.headers = { Authorization: `Bearer ${token}` }
  return api.get(`/binders/${binderId}/export-csv`, config).then(r => {
    const url = window.URL.createObjectURL(r.data)
    const a = document.createElement('a')
    a.href = url
    a.download = `binder-${binderId}.csv`
    document.body.appendChild(a)
    a.click()
    setTimeout(() => {
      document.body.removeChild(a)
      window.URL.revokeObjectURL(url)
    }, 0)
  })
}

// Dashboard
export const getDashboard = (params) => api.get('/dashboard/', { params })

// Analytics
export const getDuplicates = (params = {}) => api.get('/analytics/duplicates', { params })
export const getTopMovers = (days, params = {}) => api.get('/analytics/top-movers', { params: { ...params, days } })
export const getRarityStats = (params = {}) => api.get('/analytics/rarity-stats', { params })
export const getInvestmentTracker = (params = {}) => api.get('/analytics/investment-tracker', { params })
export const getTradeStats = () => api.get('/analytics/trades-summary')
export const getAnalyticsNewSets = () => api.get('/analytics/new-sets')

// Sync
export const triggerSync = () => api.post('/sync/')
export const triggerPriceSync = () => api.post('/sync/prices')
export const triggerAllPriceSync = () => api.post('/sync/prices/all')
export const getSyncStatus = () => api.get('/sync/status')
export const rescheduleFullSync = (intervalDays) => api.post('/sync/reschedule-full', { interval_days: intervalDays })
export const reschedulePriceSync = (intervalMinutes) => api.post('/sync/reschedule-prices', { interval_minutes: intervalMinutes })

// Products
export const getProducts = (params = {}) => api.get('/products/', { params })
export const getProductTypes = () => api.get('/products/types')
export const createProduct = (data) => api.post('/products/', data)
export const createProductBatch = (data) => api.post('/products/batch', data)
export const updateProduct = (id, data) => api.put(`/products/${id}`, data)
export const bulkUpdateProductLifecycle = (data) => api.put('/products/lifecycle/bulk', data)
export const deleteProduct = (id) => api.delete(`/products/${id}`)
export const getProductsSummary = (params = {}) => api.get('/products/summary', { params })
export const linkProductCard = (productId, data) => api.post(`/products/${productId}/cards`, data).then(r => r.data)
export const linkProductCards = (productId, data) => api.post(`/products/${productId}/cards/bulk`, data).then(r => r.data)
export const unlinkProductCard = (productId, productCardId) => api.delete(`/products/${productId}/cards/${productCardId}`).then(r => r.data)
export const sellProductCard = (productId, productCardId, data) => api.post(`/products/${productId}/cards/${productCardId}/sell`, data).then(r => r.data)
export const addProductLedgerEntry = (productId, data) => api.post(`/products/${productId}/ledger`, data).then(r => r.data)

export const getTrades = () => api.get('/trades/').then(r => r.data)
export const getTrade = (id) => api.get(`/trades/${id}`).then(r => r.data)
export const createTrade = (data, params = {}) => api.post('/trades/', data, { params }).then(r => r.data)
export const updateTrade = (id, data, params = {}) => api.put(`/trades/${id}`, data, { params }).then(r => r.data)
export const valueTrade = (data, params = {}) => api.post('/trades/value', data, { params }).then(r => r.data)

// Export
export const exportCSV = (params = {}) => {
  const token = localStorage.getItem('token')
  const config = {
    responseType: 'blob',
    params,
  }
  if (token) {
    config.headers = { Authorization: `Bearer ${token}` }
  }
  return api.get('/export/csv', config).then(r => {
    const url = window.URL.createObjectURL(r.data)
    const a = document.createElement('a')
    a.href = url
    a.download = 'collection.csv'
    a.click()
    window.URL.revokeObjectURL(url)
  })
}
export const exportPDF = (params = {}) => {
  const token = localStorage.getItem('token')
  const config = {
    responseType: 'blob',
    params,
  }
  if (token) {
    config.headers = { Authorization: `Bearer ${token}` }
  }
  return api.get('/export/pdf', config).then(r => {
    const url = window.URL.createObjectURL(r.data)
    const a = document.createElement('a')
    a.href = url
    a.download = 'collection.pdf'
    a.click()
    window.URL.revokeObjectURL(url)
  })
}

// Backup
export const downloadBackup = (include = 'full') => {
  const token = localStorage.getItem('token')
  const config = {
    responseType: 'blob',
    params: { include },
  }
  if (token) {
    config.headers = { Authorization: `Bearer ${token}` }
  }
  return api.get('/backup/download', config).then(r => {
    const url = window.URL.createObjectURL(r.data)
    const a = document.createElement('a')
    a.href = url
    a.download = 'pokemon_tcg_backup.sql'
    a.click()
    window.URL.revokeObjectURL(url)
  })
}
export const restoreBackup = (file) => {
  const formData = new FormData()
  formData.append('file', file)
  return api.post('/backup/restore', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })
}

// Settings
export const getSettings = () => api.get('/settings/')
export const saveSettings = (data) => api.put('/settings/', data)
export const getSetting = (key) => api.get(`/settings/${key}`).then(r => r.data)
export const setSetting = (key, value) => api.post(`/settings/${key}`, { value }).then(r => r.data)
export const getScannerConfiguration = () => api.get('/settings/scanner').then(r => r.data)
export const updateScannerConfiguration = (data) => api.put('/settings/scanner', data).then(r => r.data)
export const testScannerConfiguration = (data) => api.post('/settings/scanner/test', data).then(r => r.data)
export const getTelegramStatus = () => api.get('/settings/telegram_status').then(r => r.data)
export const deleteScanDiagnostics = () => api.delete('/settings/scan-diagnostics').then(r => r.data)

export const downloadDebugLog = () => {
  const token = localStorage.getItem('token')
  const config = { responseType: 'blob' }
  if (token) {
    config.headers = { Authorization: `Bearer ${token}` }
  }
  return api.get('/settings/debug-log', config).then(r => {
    const url = window.URL.createObjectURL(r.data)
    const a = document.createElement('a')
    a.href = url
    a.download = 'pokecollector-debug.log'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => window.URL.revokeObjectURL(url), 0)
  })
}

// GitHub / Community
export const getContributors = () => api.get('/github/contributors').then(r => r.data)
export const getSupporters = () => api.get('/community/supporters').then(r => r.data)
export const getRescueDonations = () => api.get('/github/rescue-donations').then(r => r.data)

// Decks (preconstructed-deck completion tracking)
export const searchDecks = (q) => api.get('/decks/search', { params: { q } }).then(r => r.data)
export const parseDeckPage = (title, productType = null) =>
  api.post('/decks/parse', { title, product_type: productType }).then(r => r.data)
export const saveDeck = (data) => api.post('/decks/', data).then(r => r.data)
export const getDeckInstances = () => api.get('/decks/instances').then(r => r.data)
export const getDeckInstance = (id) => api.get(`/decks/instances/${id}`).then(r => r.data)
export const resetDeckInstance = (id) => api.post(`/decks/instances/${id}/reset`).then(r => r.data)
export const deleteDeckInstance = (id) => api.delete(`/decks/instances/${id}`).then(r => r.data)
// traceId is optional — round-tripped from the recognizeCard() response
// that produced this scan (only present when that user has scan
// diagnostics enabled) so the reversal can be correlated back to it.
export const undoLastScan = (instanceId, cardId, traceId) =>
  api.post(`/decks/instances/${instanceId}/scans/${encodeURIComponent(cardId)}/undo`, null, {
    params: traceId ? { trace_id: traceId } : undefined,
  }).then(r => r.data)

// Same shape as undoLastScan, but for a scan whose deck_scan_status wasn't
// 'counted' (not_in_deck / already_complete) — undo_scan can't safely
// reverse those (see its own docstring and docs/plans/scanner-ux-todos.md
// item 5), so this hits the collection-only route instead, which only
// ever touches the CollectionItem row, never deck progress. traceId is
// optional, same as undoLastScan's own.
export const undoLastScanCollectionOnly = (instanceId, cardId, traceId) =>
  api.post(`/decks/instances/${instanceId}/scans/${encodeURIComponent(cardId)}/undo-collection-only`, null, {
    params: traceId ? { trace_id: traceId } : undefined,
  }).then(r => r.data)

// Persistent per-deck toggle (docs/plans/scanner-ux-todos.md item 11) for
// whether a scan adds to the general collection, or only verifies/tracks
// deck progress via the two routes below without ever touching CollectionItem.
export const updateDeckInstanceSettings = (instanceId, settings) =>
  api.post(`/decks/instances/${instanceId}/settings`, settings).then(r => r.data)

// Verify-only counterpart to addToCollection: moves deck progress but never
// creates or touches a CollectionItem row. Not unwrapping .data here, same
// as addToCollection's own raw-response return.
export const verifyDeckScan = (instanceId, cardId, quantity = 1) =>
  api.post(`/decks/instances/${instanceId}/scans/${encodeURIComponent(cardId)}/verify`, null, { params: { quantity } })

// Same shape as undoLastScan, but reverses a verifyDeckScan call — there's
// no CollectionItem side to a verify-only scan, so this only ever touches
// deck progress.
export const undoVerifyDeckScan = (instanceId, cardId, traceId) =>
  api.post(`/decks/instances/${instanceId}/scans/${encodeURIComponent(cardId)}/undo-verify`, null, {
    params: traceId ? { trace_id: traceId } : undefined,
  }).then(r => r.data)

// Social
export const getLeaderboard = (params = {}) => api.get('/social/leaderboard', { params })
export const compareUsers = (userId, params = {}) => api.get(`/social/compare/${userId}`, { params })
export const getAchievements = (userId, params = {}) => api.get(`/social/achievements/${userId}`, { params })

export default api

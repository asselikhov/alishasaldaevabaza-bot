const Settings = require('../models/Settings');

let cachedSettings = null;

async function getSettings() {
  if (!cachedSettings) {
    console.log('[SETTINGS] Loading settings from database');
    cachedSettings = await Settings.findOne() || new Settings();
  } else {
    console.log('[SETTINGS] Returning cached settings');
  }
  return cachedSettings;
}

async function resetSettingsCache() {
  console.log('[SETTINGS] Resetting settings cache');
  cachedSettings = null;
}

module.exports = { getSettings, resetSettingsCache };
// popup.js
const runtime = typeof browser !== 'undefined' ? browser : chrome;
const TOGGLE_KEY = 'extension_enabled';
const DEFAULT_ENABLED = true;

const toggleSwitch = document.getElementById('toggleSwitch');
const status = document.getElementById('status');

runtime.storage.local.get([TOGGLE_KEY], (result) => {
  const isEnabled = result[TOGGLE_KEY] !== undefined ? result[TOGGLE_KEY] : DEFAULT_ENABLED;
  updateToggle(isEnabled);
});

toggleSwitch.addEventListener('click', () => {
  runtime.storage.local.get([TOGGLE_KEY], (result) => {
    const currentState = result[TOGGLE_KEY] !== undefined ? result[TOGGLE_KEY] : DEFAULT_ENABLED;
    const newState = !currentState;
    
    runtime.storage.local.set({ [TOGGLE_KEY]: newState }, () => {
      updateToggle(newState);
      
      runtime.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
          runtime.tabs.sendMessage(tabs[0].id, {
            type: 'extensionToggle',
            enabled: newState
          }).catch(() => {});
        }
      });
    });
  });
});

function updateToggle(isEnabled) {
  if (isEnabled) {
    toggleSwitch.classList.add('enabled');
    status.textContent = 'Extension is enabled';
    status.style.color = '#1d9bf0';
  } else {
    toggleSwitch.classList.remove('enabled');
    status.textContent = 'Extension is disabled';
    status.style.color = '#536471';
  }
}
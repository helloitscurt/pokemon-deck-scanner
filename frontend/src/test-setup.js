// Registers @testing-library/jest-dom's DOM-specific matchers (toBeInTheDocument,
// toBeDisabled, etc.) globally. Safe to load under every test's environment,
// including the default 'node' one most of this repo's tests still use —
// the matchers only do anything when actually called against a DOM node.
import '@testing-library/jest-dom/vitest'

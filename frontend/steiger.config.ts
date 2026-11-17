import fsd from '@feature-sliced/steiger-plugin'
import { defineConfig } from 'steiger'

// The official Feature-Sliced Design rules, as recommended: `npm run lint` runs them on src/
export default defineConfig([...fsd.configs.recommended])

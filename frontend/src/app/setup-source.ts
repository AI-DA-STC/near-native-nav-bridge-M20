import { connectSetup, createSetupSocket } from '@/shared/api'

/* Where the setup facts come from: the setup server in frontend/server, on this page's own host (npm run dev serves
 * both), connected once before the first render */

connectSetup(createSetupSocket())

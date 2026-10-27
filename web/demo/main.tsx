import { mountOsView } from '../src/mount';
import { bumpFixtureLive, createFixtureHost } from './fixtureHost';

const root = document.getElementById('root');
if (!root) throw new Error('System demo: #root is missing from demo/index.html');
const view = mountOsView(root, createFixtureHost(), { theme: 'dark', projectName: 'Demo project' });
// Test hook for the browser checks: the live-refresh simulation calls notifyChange after a bump.
(window as unknown as { __osView?: unknown; __osBump?: () => void }).__osView = view;
(window as unknown as { __osBump?: () => void }).__osBump = bumpFixtureLive;

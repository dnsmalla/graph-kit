import { mountOsView } from '../src/mount';
import { createFixtureHost } from './fixtureHost';

const root = document.getElementById('root');
if (!root) throw new Error('System demo: #root is missing from demo/index.html');
mountOsView(root, createFixtureHost(), { theme: 'dark', projectName: 'Demo project' });

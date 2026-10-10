import test from 'node:test';
import assert from 'node:assert/strict';
import { mapGamepad, mapKeyboard } from './input-map.js';
import { BUTTONS } from '../shared/protocol.js';

test('standard gamepad controls map to N64 buttons and analog axes', () => {
  const buttons = Array.from({ length: 16 }, () => ({ pressed: false, value: 0 }));
  for (const index of [0, 1, 3, 4, 5, 6, 9, 12, 14]) buttons[index] = { pressed: true, value: 1 };
  const result = mapGamepad({ buttons, axes: [-1, 0.575, -1, 1] });
  assert.equal(result.buttons, BUTTONS.A | BUTTONS.B | BUTTONS.Z | BUTTONS.L | BUTTONS.R | BUTTONS.START | BUTTONS.UP | BUTTONS.LEFT | BUTTONS.C_UP | BUTTONS.C_DOWN | BUTTONS.C_LEFT);
  assert.equal(result.sx, -80);
  assert.equal(result.sy, 40);
});

test('gamepad deadzone and absent controller produce neutral input', () => {
  assert.deepEqual(mapGamepad(null), { buttons: 0, sx: 0, sy: 0 });
  assert.equal(mapGamepad({ buttons: [], axes: [0.1, -0.15] }).sx, 0);
  assert.equal(mapGamepad({ buttons: [], axes: [0.1, -0.15] }).sy, 0);
});

test('keyboard mapping supports stick, d-pad, and documented button keys', () => {
  const result = mapKeyboard(new Set(['w', 'd', 'j', 'k', 'l', 'q', 'e', 'Enter', 'u', 'n', 'h', 'i', 'ArrowLeft']));
  assert.equal(result.sx, 80);
  assert.equal(result.sy, -80);
  assert.equal(result.buttons, BUTTONS.A | BUTTONS.B | BUTTONS.Z | BUTTONS.L | BUTTONS.R | BUTTONS.START | BUTTONS.C_UP | BUTTONS.C_DOWN | BUTTONS.C_LEFT | BUTTONS.C_RIGHT | BUTTONS.LEFT);
  assert.deepEqual(mapKeyboard(new Set()), { buttons: 0, sx: 0, sy: 0 });
});

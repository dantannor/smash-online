import test from 'node:test';
import assert from 'node:assert/strict';
import { mapGamepad, mapKeyboard, logicalKeys, TILT_STICK } from './input-map.js';
import { BUTTONS } from '../shared/protocol.js';

test('standard gamepad controls map to N64 buttons and analog axes', () => {
  const buttons = Array.from({ length: 16 }, () => ({ pressed: false, value: 0 }));
  for (const index of [0, 1, 3, 4, 5, 6, 9, 12, 14]) buttons[index] = { pressed: true, value: 1 };
  const result = mapGamepad({ buttons, axes: [-1, 0.575, -1, 1] });
  assert.equal(result.buttons, BUTTONS.A | BUTTONS.B | BUTTONS.Z | BUTTONS.L | BUTTONS.R | BUTTONS.START | BUTTONS.UP | BUTTONS.LEFT | BUTTONS.C_UP | BUTTONS.C_DOWN | BUTTONS.C_LEFT);
  assert.equal(result.sx, -80);
  assert.equal(result.sy, -40);
});

test('gamepad deadzone and absent controller produce neutral input', () => {
  assert.deepEqual(mapGamepad(null), { buttons: 0, sx: 0, sy: 0 });
  assert.equal(mapGamepad({ buttons: [], axes: [0.1, -0.15] }).sx, 0);
  assert.equal(mapGamepad({ buttons: [], axes: [0.1, -0.15] }).sy, 0);
});

test('keyboard mapping supports stick, d-pad, and documented button keys', () => {
  const result = mapKeyboard(new Set(['w', 'd', 'j', 'k', 'l', 'q', 'e', 'Enter', 'u', 'n', 'h', 'i', 'ArrowLeft']));
  assert.equal(result.sx, 80);
  assert.equal(result.sy, 80);
  assert.equal(result.buttons, BUTTONS.A | BUTTONS.B | BUTTONS.Z | BUTTONS.L | BUTTONS.R | BUTTONS.START | BUTTONS.C_UP | BUTTONS.C_DOWN | BUTTONS.C_LEFT | BUTTONS.C_RIGHT | BUTTONS.LEFT);
  assert.deepEqual(mapKeyboard(new Set()), { buttons: 0, sx: 0, sy: 0 });
});

test('WASD and arrows follow the game stick convention (up is +sy)', () => {
  for (const [keys, sx, sy] of [[['w'], 0, 80], [['s'], 0, -80], [['a'], -80, 0], [['d'], 80, 0], [['ArrowUp'], 0, 80], [['ArrowDown'], 0, -80], [['ArrowLeft'], -80, 0], [['ArrowRight'], 80, 0]]) {
    const result = mapKeyboard(new Set(keys));
    assert.deepEqual({ sx: result.sx, sy: result.sy }, { sx, sy }, keys.join());
  }
  assert.equal(mapGamepad({ buttons: [], axes: [0, -1] }).sy, 80, 'stick pushed up');
});

test('Shift is a half-stick tilt modifier and does not change buttons', () => {
  assert.deepEqual(mapKeyboard(new Set(['d', 'j'])), { buttons: BUTTONS.A, sx: 80, sy: 0 });
  assert.deepEqual(mapKeyboard(new Set(['Shift', 'd', 'j'])), { buttons: BUTTONS.A, sx: TILT_STICK, sy: 0 });
  assert.deepEqual(mapKeyboard(new Set(['Shift', 'a', 's'])), { buttons: 0, sx: -TILT_STICK, sy: -TILT_STICK });
  assert.equal(TILT_STICK > 8 && TILT_STICK < 53, true, 'between walking and the smash flick threshold');
});

test('keys are read from event.code so layout and Shift cannot change or strand a held key', () => {
  assert.deepEqual([...logicalKeys(['KeyD', 'KeyJ', 'ShiftLeft', 'ArrowUp', 'NumpadEnter', 'Space'])].sort(), ['ArrowUp', 'Enter', 'Shift', 'd', 'j']);
  assert.deepEqual(mapKeyboard(logicalKeys(['KeyD', 'KeyK'])), { buttons: BUTTONS.B, sx: 80, sy: 0 });
});

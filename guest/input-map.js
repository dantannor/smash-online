import { BUTTONS } from '../shared/protocol.js';
const emptyInput = () => ({ buttons: 0, sx: 0, sy: 0 });
const axisValue = (v, deadzone = 0.15) => {
  if (!Number.isFinite(v) || Math.abs(v) <= deadzone) return 0;
  const scaled = (Math.abs(v) - deadzone) / (1 - deadzone);
  return Math.round(Math.sign(v) * Math.min(1, scaled) * 80);
};
const down = (button) => Boolean(button && (button.pressed || button.value > 0.5));

export function mapGamepad(gamepad) {
  const result = emptyInput();
  if (!gamepad) return result;
  const b = gamepad.buttons || [];
  const set = (condition, mask) => { if (condition) result.buttons |= mask; };
  set(down(b[0]), BUTTONS.A);
  set(down(b[1]) || down(b[2]), BUTTONS.B);
  set(down(b[6]) || down(b[7]), BUTTONS.Z);
  set(down(b[4]), BUTTONS.L);
  set(down(b[5]), BUTTONS.R);
  set(down(b[9]), BUTTONS.START);
  set(down(b[12]), BUTTONS.UP); set(down(b[13]), BUTTONS.DOWN);
  set(down(b[14]), BUTTONS.LEFT); set(down(b[15]), BUTTONS.RIGHT);
  set(down(b[3]), BUTTONS.C_UP); // Y
  const axes = gamepad.axes || [];
  const cx = axes[2] || 0, cy = axes[3] || 0;
  set(cy < -0.35, BUTTONS.C_UP); set(cy > 0.35, BUTTONS.C_DOWN);
  set(cx < -0.35, BUTTONS.C_LEFT); set(cx > 0.35, BUTTONS.C_RIGHT);
  result.sx = axisValue(axes[0]);
  result.sy = -axisValue(axes[1]) || 0; // Gamepad Y is down-positive; the game's stick Y is up-positive.
  return result;
}

// Hold Shift for a half stick: SSB64 smash attacks need a full-stick flick, tilts and walking use less.
export const TILT_STICK = 40;

// event.code is the physical key, so a Hebrew or other layout still gets WASD/JKL, and Shift cannot change a held key's name
// (with event.key, 'd' down then Shift+release produced 'D' up and left 'd' stuck).
export function logicalKeys(codes) {
  const out = new Set();
  for (const code of codes) {
    if (/^Key[A-Z]$/.test(code)) out.add(code.slice(3).toLowerCase());
    else if (code === 'ShiftLeft' || code === 'ShiftRight') out.add('Shift');
    else if (code === 'Enter' || code === 'NumpadEnter') out.add('Enter');
    else if (code.startsWith('Arrow')) out.add(code);
  }
  return out;
}

export function mapKeyboard(keys) {
  const result = emptyInput();
  const has = (key) => keys instanceof Set ? keys.has(key) : Boolean(keys?.[key]);
  const set = (key, mask) => { if (has(key)) result.buttons |= mask; };
  if (has('ArrowLeft') || has('a') || has('A')) result.sx = -80;
  if (has('ArrowRight') || has('d') || has('D')) result.sx = 80;
  if (has('ArrowUp') || has('w') || has('W')) result.sy = 80;
  if (has('ArrowDown') || has('s') || has('S')) result.sy = -80;
  set('j', BUTTONS.A); set('J', BUTTONS.A);
  set('k', BUTTONS.B); set('K', BUTTONS.B);
  set('l', BUTTONS.Z); set('L', BUTTONS.Z);
  set('q', BUTTONS.L); set('Q', BUTTONS.L);
  set('e', BUTTONS.R); set('E', BUTTONS.R);
  set('Enter', BUTTONS.START);
  set('u', BUTTONS.C_UP); set('U', BUTTONS.C_UP);
  set('n', BUTTONS.C_DOWN); set('N', BUTTONS.C_DOWN);
  set('h', BUTTONS.C_LEFT); set('H', BUTTONS.C_LEFT);
  set('i', BUTTONS.C_RIGHT); set('I', BUTTONS.C_RIGHT);
  set('ArrowUp', BUTTONS.UP); set('ArrowDown', BUTTONS.DOWN);
  set('ArrowLeft', BUTTONS.LEFT); set('ArrowRight', BUTTONS.RIGHT);
  if (has('Shift')) { result.sx = Math.sign(result.sx) * TILT_STICK; result.sy = Math.sign(result.sy) * TILT_STICK; }
  return result;
}

export { BUTTONS };

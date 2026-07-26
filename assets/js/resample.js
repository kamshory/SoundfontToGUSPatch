import { VOICE_FREE, MODES_LOOPING } from './types.js';

const FRACTION_BITS = 12;
const FRACTION_MASK = (1 << FRACTION_BITS) - 1;

function PRECALC_LOOP_COUNT(start, end, incr) {
  return Math.floor((end - start + incr - 1) / incr);
}

function rs_plain(song, v, countptr) {
  const vp = song.voice[v];
  const dest = song.resample_buffer;
  const src = vp.sample.data;
  
  let ofs = vp.sample_offset;
  let incr = vp.sample_increment;
  const le = vp.sample.data_length;
  let count = countptr[0];

  if (ofs >= le) {
    vp.status = VOICE_FREE;
    countptr[0] = 0;
    return dest;
  }

  if (incr < 0) incr = -incr;

  let i = PRECALC_LOOP_COUNT(ofs, le, incr);
  if (i > count) i = count;

  countptr[0] = i; // The number of samples we will render.

  let destIdx = 0;
  for (let j = 0; j < i; j++) {
    const idx = ofs >> FRACTION_BITS;
    const v1 = src[idx];
    // Boundary check to prevent reading past the end of the sample data
    let v2;
    if (idx < src.length - 1) {
      v2 = src[idx + 1];
    } else {
      v2 = v1; // If at the end, don't interpolate
    }
    dest[destIdx++] = v1 + (((v2 - v1) * (ofs & FRACTION_MASK)) / (1 << FRACTION_BITS));
    ofs += incr;
  }

  if (ofs >= le) {
    vp.status = VOICE_FREE; // Mark as free for the *next* block
  }

  vp.sample_offset = ofs;
  return dest;
}

function rs_loop(song, vp, count) {
  let ofs = vp.sample_offset;
  let incr = vp.sample_increment;
  // CRITICAL FIX: Convert loop points to fixed-point integers to match C logic
  const loop_end_fixed = (vp.sample.loop_end << FRACTION_BITS) | 0;
  const loop_start_fixed = (vp.sample.loop_start << FRACTION_BITS) | 0;
  const loop_len_fixed = loop_end_fixed - loop_start_fixed;
  const dest = song.resample_buffer;
  const src = vp.sample.data;
  let destIdx = 0;

  if (loop_len_fixed <= 0) {
    vp.status = VOICE_FREE;
    return dest;
  }

  while (count > 0) {
    while (ofs >= loop_end_fixed) {
      ofs -= loop_len_fixed;
    }
    let i = PRECALC_LOOP_COUNT(ofs, loop_end_fixed, incr);
    if (i > count) {
      i = count;
      count = 0;
    } else {
      count -= i;
    }
    for (let j = 0; j < i; j++) {
      const idx = ofs >> FRACTION_BITS;
      const v1 = src[idx];
      // Boundary check for safety, although loops should prevent this.
      let v2;
      if ((ofs + incr) < loop_end_fixed) { // Check against loop end
        v2 = src[idx + 1];
      } else {
        v2 = src[loop_start_fixed >> FRACTION_BITS]; // Wrap around to loop start
      }
      dest[destIdx++] = v1 + (((v2 - v1) * (ofs & FRACTION_MASK)) / (1 << FRACTION_BITS));
      ofs += incr;
    }
  }

  vp.sample_offset = ofs;
  return dest;
}

export function resample_voice(song, v, countptr) {
  const vp = song.voice[v];
  const modes = vp.sample.modes;

  // Simple dispatcher mimicking libtimidity
  if (modes & MODES_LOOPING) { // MODES_LOOPING
    return rs_loop(song, vp, countptr[0]);
  } else {
    return rs_plain(song, v, countptr);
  }
}

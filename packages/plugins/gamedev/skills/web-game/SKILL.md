---
name: web-game
description: Use when building, debugging or tuning a browser game made with Phaser, Three.js, Babylon.js, PixiJS or a similar framework, including the game loop, input, physics, asset loading and performance.
---

# Browser game engineering

## Verify in the browser

Run `game_playtest` after every change that affects what the player sees or does. Pass `actions` to reproduce the situation you changed, for example holding an arrow key for movement or clicking a menu button. Read the screenshot and the error list before you report back.

Example: move right for one second, then jump.

```json
{ "seconds": 4, "actions": [{ "type": "hold", "key": "ArrowRight", "ms": 1000 }, { "type": "press", "key": "Space" }] }
```

Click coordinates are relative to the game canvas.

## Measure, don't eyeball

A screenshot shows where things are, not how fast they got there. To prove a gameplay change, read the game's state with `probes`: JavaScript expressions evaluated once the game has loaded and again after the inputs.

Games built with a bundler keep their objects out of `window`, so expose them in development builds first:

```js
const game = new Phaser.Game(config)
if (import.meta.env.DEV) window.__game = game
```

Then probe what changed. For example, to measure how far the ship moves while ArrowRight is held for 300 ms:

```json
{
  "seconds": 1,
  "actions": [{ "type": "hold", "key": "ArrowRight", "ms": 300 }],
  "probes": ["window.__game.scene.scenes[0].ship.x", "window.__game.scene.scenes[0].ship.body.velocity.x"]
}
```

Keep holds short enough that the object does not reach a wall or a speed cap, or every version will look the same. For a relative claim ("25% faster"), run once with the old value and once with the new one and compare the numbers.

To compare values without editing the file between runs, read a query parameter in development code and pass it with `path`. `game_playtest` opens that page on the dev server it starts, so you never need to run a server yourself:

```js
const params = import.meta.env.DEV ? new URLSearchParams(location.search) : undefined
const accel = Number(params?.get("accel") ?? 750)
```

```json
{ "path": "?accel=600", "actions": [{ "type": "hold", "key": "ArrowRight", "ms": 300 }], "probes": ["window.__game.scene.scenes[0].ship.body.velocity.x"] }
```

Remove measurement code before you finish unless the user wants to keep it.

When you change a value that controls feel, look for limits that cap it (maximum velocity, clamps, cooldowns) and say whether the change is still visible under them.

## Game loop

- Scale movement by the frame delta (`delta` in Phaser's `update(time, delta)`, `clock.getDelta()` in Three.js) so speed does not depend on frame rate.
- Do not allocate objects, arrays or closures inside the per-frame update. Reuse vectors and pool frequently spawned objects such as bullets and particles.
- Never block the render loop with synchronous work such as large JSON parsing or loops over every entity every frame.

## Input

- Browsers only allow audio after a user gesture. Start or resume the audio context on the first click or key press.
- Keyboard events need the page focused. Canvas games in iframes often need a click first.
- Prevent default browser behavior for game keys (arrow keys and Space scroll the page).

## Assets

- Load assets in a preload step and show progress; do not load in the middle of gameplay.
- A `[http 404]` or `[request failed]` line in a playtest is usually a wrong path or a file missing from the public/static folder.
- Paths that work under the dev server can break after a build when the game is served from a subfolder. Use the bundler's base URL setting.

## Performance

- Watch the playtest frame rate before and after a change. A drop is a regression even when nothing looks wrong.
- Batch draw calls: texture atlases, sprite batching, instanced meshes in Three.js and Babylon.js.
- Remove objects that leave the world, and destroy physics bodies along with them.

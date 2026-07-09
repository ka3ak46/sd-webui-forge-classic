# Forge Quick Presets

Delta presets for Forge NEO.

Stable local version: `0.1.0` (2026-04-29).

The extension adds a small `Quick Presets` panel below the generation preview. It captures the current UI as a baseline, saves almost any UI field changed after that baseline, and applies those changed fields later without touching Forge's model preset selectors or user-provided media.

Quick Presets are separate from native Forge `UI Preset`s. They do not edit, overwrite, rename, delete, or otherwise modify Forge's built-in preset system.

Excluded by default:

- Forge UI Preset
- Checkpoint
- VAE / Text Encoder
- Diffusion dtype
- prompts
- image, mask, gallery, upload fields
- generate/interrupt/skip controls
- ControlNet `Control Type` filter state

Recommended save flow:

1. Press `Reset` to return the current tab to the captured baseline before starting a new quick preset.
2. Choose the native Forge `UI Preset` / model type that the new quick preset should belong to.
3. Make only the changes that should be saved: generation settings, Refiner, ControlNet units, ADetailer, Scripts, extension fields, denoise, CFG, steps, and similar UI controls.
4. Press `Save Changed`.
5. Before saving another quick preset, press `Reset` again, switch to the needed native Forge `UI Preset`, then make the next set of changes.

When applying a quick preset later, choose the matching native Forge `UI Preset` first, then apply the saved quick preset.

To revise an existing quick preset:

1. Select and apply the preset.
2. Adjust the UI fields you want to change.
3. Press `Update` and confirm.

Notes:

- Native Forge `UI Preset`s are not modified; quick presets are stored separately.
- ControlNet image, mask, gallery, and upload fields are intentionally ignored.

Presets are stored in `presets/user_presets.json`.

## License

Forge Quick Presets is free for non-commercial use and redistribution with attribution. It may not be sold or included in paid products, bundles, subscriptions, or commercial distributions, including modified versions. If you want to monetize it in any way, including paid builds or paid bundles, contact the author first and obtain written permission. See [LICENSE.md](LICENSE.md).

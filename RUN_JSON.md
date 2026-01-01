# run.json Format

The `run.json` file is an optional metadata file that should be included in the ZIP archive when uploading a cartridge. It provides additional information about how to run the game.

## Universal ZIP Format

All games follow a universal ZIP structure containing a `run.json` and the game files:

```
game.zip
├── run.json          ← Configuration file
├── GAME.EXE          ← For DOS games
├── game.gb           ← For Game Boy games
├── game.gbc          ← For Game Boy Color games
└── ...               ← Additional files (data, saves, etc.)
```

## Schema

```json
{
  "title": "Game Title",
  "filename": "game.zip",
  "executable": "GAME.EXE",
  "rom": "game.gb",
  "platform": "DOS"
}
```

## Fields

### Required Fields

None - all fields are optional. However, it's recommended to include at least `title` and `platform` for better UX.

### Optional Fields

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `title` | string | Display title of the game. Used in the UI to show the game name. Falls back to catalog title if not provided. | `"Commander Keen"` |
| `filename` | string | Filename of the ZIP archive. Used for download filename. Defaults to `"game.zip"` if not provided. | `"keen.zip"` |
| `executable` | string | Path to the main executable file to run (DOS games). Should be relative to the ZIP root. Falls back to auto-detection if not provided. | `"KEEN.EXE"` or `"GAME/KEEN.EXE"` |
| `rom` | string | Path to the ROM file (GB/GBC games). Should be relative to the ZIP root. Falls back to auto-detection if not provided. | `"pokemon.gb"` or `"zelda.gbc"` |
| `platform` | string | Platform name. Can be `"DOS"`, `"GB"`, `"GBC"`. This overrides the platform code from the CART header. | `"DOS"` |

## Platform-Specific Details

### DOS Games

- Uses JS-DOS (DOSBox WebAssembly) for emulation
- Set `platform` to `"DOS"`
- Use `executable` field to specify the main .EXE, .COM, or .BAT file
- Auto-detects executables if not specified

### Game Boy (GB) Games

- Uses binjgb WebAssembly emulator for emulation
- Set `platform` to `"GB"`
- Use `rom` field to specify the .gb file (optional - auto-detected)
- Supports save states and audio

### Game Boy Color (GBC) Games

- Uses binjgb WebAssembly emulator for emulation
- Set `platform` to `"GBC"`
- Use `rom` field to specify the .gbc file (optional - auto-detected)
- Full color palette support

## Examples

### DOS Game Example

```json
{
  "title": "Commander Keen",
  "filename": "keen.zip",
  "executable": "KEEN.EXE",
  "platform": "DOS"
}
```

### Game Boy Game Example

```json
{
  "title": "Tetris",
  "filename": "tetris.zip",
  "rom": "tetris.gb",
  "platform": "GB"
}
```

### Game Boy Color Game Example

```json
{
  "title": "Pokemon Crystal",
  "filename": "pokemon-crystal.zip",
  "rom": "crystal.gbc",
  "platform": "GBC"
}
```

Note: For GB/GBC games, the `rom` field is optional as the emulator will automatically find .gb or .gbc files in the ZIP.

### Minimal Example (Auto-Detection)

```json
{
  "title": "My Game",
  "platform": "GB"
}
```

## Behavior

1. **If `run.json` is missing**: The system will still work, but will use defaults:
   - Title: Falls back to catalog title (from CENT entry)
   - Filename: Defaults to `"game.zip"`
   - Executable/ROM: Auto-detected from ZIP contents
   - Platform: Uses platform code from CART header

2. **If `run.json` exists but fields are missing**: The system uses the same fallbacks as above.

3. **Priority**: `run.json` values take precedence over catalog/CART header values when both are available.

## Auto-Detection Rules

### DOS Games
1. If `executable` is specified in `run.json`, use that
2. Otherwise, search for .EXE, .COM, .BAT files
3. Prefer files matching the ZIP filename (e.g., `keen1.exe` for `keen1.zip`)
4. Skip utility files (setup.exe, install.exe, etc.)

### GB/GBC Games
1. If `rom` is specified in `run.json`, use that
2. Otherwise, search for .gb, .gbc, .sgb files
3. Use the first ROM file found

## Integration with Uploader

When using the `package` command to create a ZIP file, you can manually add `run.json` to the directory before packaging:

```bash
# Create run.json for a DOS game
cat > run.json << EOF
{
  "title": "My DOS Game",
  "executable": "GAME.EXE",
  "platform": "DOS"
}
EOF

# Create run.json for a Game Boy game
cat > run.json << EOF
{
  "title": "My GB Game",
  "rom": "game.gb",
  "platform": "GB"
}
EOF

# Package the directory (run.json will be included)
./uploader package --dir ./game-files --output game.zip
```

## Emulator Controls

### DOS Games (JS-DOS)
- Standard keyboard input is passed through to DOSBox
- Click on the emulator to capture keyboard focus

### Game Boy / Game Boy Color (binjgb)
| Game Button | Keyboard Key |
|-------------|-------------|
| D-Pad Up | Arrow Up |
| D-Pad Down | Arrow Down |
| D-Pad Left | Arrow Left |
| D-Pad Right | Arrow Right |
| A Button | X |
| B Button | Z |
| Start | Enter |
| Select | Shift |

Touch controls are automatically shown on mobile devices.

## Notes

- The file must be valid JSON
- Field names are case-sensitive
- Paths should use forward slashes (`/`) for cross-platform compatibility
- Paths are relative to the ZIP root, not absolute
- ROM files can have extensions: .gb, .gbc, .sgb

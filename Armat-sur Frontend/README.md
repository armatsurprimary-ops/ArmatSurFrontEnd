# Armat Sur session runner

See the package's `README.md` for player setup. Python 3.10+ and a modern browser
are sufficient to run the app; Node.js and npm are only needed for development.

Windows: double-click `start-armatsur.bat`.
Other systems: run `python3 serve.py 8000` here, then open http://localhost:8000.
Use the included server for session saving and the Abliteration.ai relay.

The bundled rules match the PDF release. Recognized older bundled editions are
refreshed automatically; custom rulebooks are retained. To replace a custom book,
use the rulebook-loading control in Settings.

Service details: `API-SERVICES.md`. Images in context: `REFERENCE-ATTACHMENTS.md`.
Default editable instructions: `SYSTEM-PROMPT-DEFAULTS.txt`.

## Development checks

Run `npm ci` here, then `npm test`.
Run `python -m unittest discover -s tests -p test_server.py -v` for server tests
(use `python3` if that is your Python command).

App code is Apache 2.0; game prose and project artwork are CC BY 4.0. The page-turn
sound is separately licensed. See the package's licensing files.

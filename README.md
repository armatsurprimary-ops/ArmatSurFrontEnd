# What is this?
A front end for Armat-Sur, an 18+ AI driven RPG. The front end manages context and prevents NPC's and the player from writing to world state directly, instead a globally aware GM arbitrates character intentions with the setting's rule book to control outcomes. This is done to address the lack of concreteness inherit to free-form AI roleplay as found in Silly Tavern and other projects.

**NOTE: Due to the adult content in the game it is not recommended to use GPT or Claude. As of release deepseek 4.1 flash 1017 is the most suitable model for capability and cost and should be treated as a baseline.**

The rule book itself can be found at https://armatsurprimary-ops.itch.io/armat-sur, separated from this repository due to containing explicit imagery
# How to use
1. Install Python 3.10 or newer if it is not already available.
2. On Windows, open **Armat-sur Frontend** and double-click **start-armatsur.bat**.
   On macOS or Linux, open a terminal in that folder and run `python3 serve.py 8000`.
3. Open **http://localhost:8000**. Use the same address and browser each time to
   retain browser-local settings and reference images.
4. Open **Settings**, choose OpenRouter or Abliteration.ai, enter your own API key,
   fetch the model list, select a suitable GM model, and save. The current rulebook
   loads automatically. Model requests are billed by the selected service.
5. Start in the **user** branch. The welcome message introduces the tag system and
   gives you a place to discuss your game with the GM.

## Useful controls

- **Character Card** edits the selected character. The side panel displays its
  current state; the card-panel button shows or hides it.
- **System Prompt** edits GM/character instructions and previews their composition.
- Reply controls select previous generations or regenerate messages. Revising
  past text does not undo later events or restore an earlier character card.
- **Settings → Add reference images** can attach the supplied map or other images
  to context. Enable sending them and choose a model that supports image input.
- **Compact** Summarize older messages to reduce context usage in long running games.
- **Sessions** saves and loads games. **Export** creates a portable session file.

Named saves are created in `Armat-sur Frontend/saves/`. Settings/API keys remain
in browser storage; reference images are stored separately in that browser.
Session exports do not include API keys, settings, or reference image files.
The local server console displays game traffic while running. Model providers
receive the context sent for each request.

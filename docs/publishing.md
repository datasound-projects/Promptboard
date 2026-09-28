# Install and publish version 0.3.0

Use the new **`ai-prompt-engineer-ste-0.3.0`** folder. Keep an older installation in its own folder so you do not start it by mistake.

## 1. Extract and start

Install Node.js 22+ and a supported CLI. Sign in to the CLI first. Save the release ZIP in your Downloads folder.

**macOS Terminal**

```bash
cd ~/Downloads
unzip ai-prompt-engineer-ste-0.3.0.zip -d "$HOME/Desktop"
cd "$HOME/Desktop/ai-prompt-engineer-ste-0.3.0"
node bin/ste.mjs --version
npm start
```

**Windows PowerShell**

```powershell
Expand-Archive -Path "$HOME\Downloads\ai-prompt-engineer-ste-0.3.0.zip" -DestinationPath "$HOME\Desktop"
Set-Location "$HOME\Desktop\ai-prompt-engineer-ste-0.3.0"
node bin/ste.mjs --version
npm start
```

If your CLI needs WSL2, extract the ZIP and run the app inside WSL2 instead. The app and CLI must share the same environment and PATH.

The version command must print **0.3.0**. Open **http://127.0.0.1:4318**. Keep the terminal open while you use the app. Press **Ctrl+C** to stop it.

If port 4318 is in use, open the app already running there or choose another port:

```bash
npm start -- --port 4320
```

Different ports have separate browser history. Do not stop an unknown process just to free a port.

## 2. Create an empty GitHub repository

1. Sign in to GitHub and select **New repository**.
2. Choose your account or organization. Use the name **ai-prompt-engineer-ste**.
3. Set visibility to **Public** if you want an open-source project.
4. Leave **Add a README**, **Add .gitignore**, and **Choose a license** unset. These files are already included; the project uses MIT.
5. Click **Create repository**.

Suggested description:

> Turn rough ideas into clear coding prompts with STE writing principles, automatic checks, and your own AI CLI.

## 3. Upload the project

Stop the app with **Ctrl+C**, or open a second terminal in the new project folder. Install Git if the `git` command is unavailable.

The commands below use **datasound-projects** as the repository owner. Replace that name if you created the repository under another account.

```bash
git init
git add .
git commit -m "Release AI Prompt Engineer 0.3.0"
git branch -M main
git remote add origin https://github.com/datasound-projects/ai-prompt-engineer-ste.git
git push -u origin main
```

Use the plain URL shown above. Do not add Markdown brackets or parentheses. Complete GitHub authentication if Git requests it. If Git asks for your commit name and email, set those using GitHub's [Git setup instructions](https://docs.github.com/en/get-started/git-basics/set-up-git), then repeat the commit and push.

If `origin` already exists, replace the `git remote add` command with:

```bash
git remote set-url origin https://github.com/datasound-projects/ai-prompt-engineer-ste.git
```

Open your repository on GitHub and confirm the README and files are visible. A successful push uploads the source; it does not publish an npm package or host the app.

## 4. Run it again or upload later edits

From the project folder, start the app with:

```bash
npm start
```

After making local changes, upload them with:

```bash
git add .
git commit -m "Update AI Prompt Engineer"
git push
```

To let others download the exact ZIP, create a GitHub release with tag **v0.3.0** and attach **ai-prompt-engineer-ste-0.3.0.zip**. They can also use **Code → Download ZIP** for the current repository files.

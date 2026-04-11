# Daily Priorities

Ambient, low-friction task dashboard that lives on your Chrome new-tab page. Backed by Todoist.

## Setup

1. `npm install && npm run build`
2. Push to GitHub → GitHub Actions deploys to Pages
3. Go to `https://michaelewens.github.io/daily-priorities/`
4. Paste your Todoist API token (Settings → Integrations → Developer)
5. Set as Chrome homepage: Settings → On Startup → Open a specific page

For true new-tab override, use [Custom New Tab URL](https://chromewebstore.google.com/detail/custom-new-tab-url/mmjbdbjnopkjmnfellifnkbhbhmhdjhd) extension.

## How it works

- Creates a "Priorities" project in Todoist with 4 sections: Today, Active, Inbox, Waiting
- All changes sync to Todoist immediately
- Tasks added via phone/email to the Priorities project appear on refresh
- Use `@label` for project tags and `#deadline:YYYY-MM-DD` for deadlines when adding tasks
- Today: hard max 3. Active: hard cap 30.
- Light/dark follows system preference.

## Dev

```
npm install
npm run dev
```

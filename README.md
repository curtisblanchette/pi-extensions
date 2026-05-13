# pi-extensions

Curtis Blanchette's personal [pi](https://github.com/earendil-works/pi) extensions, packaged so they can be installed directly from GitHub.

## Install

```bash
pi install git:github.com/curtisblanchette/pi-extensions
```

To try without installing globally:

```bash
pi -e git:github.com/curtisblanchette/pi-extensions
```

To update after installing:

```bash
pi update git:github.com/curtisblanchette/pi-extensions
```

## Included extensions

- `commit-pr.ts` — `/commit` and `/commit-pr` interactive Git commit/push/draft PR workflow.
- `prs.ts` — `/prs` browser for open/draft GitHub PRs with PR actions.
- `sync-pr-labels.ts` — `/sync-pr-labels` command to sync approved PR workflow labels.

## Development

```bash
npm install
npm run check
```

This package declares pi resources in `package.json`:

```json
{
  "pi": {
    "extensions": ["./extensions"]
  }
}
```

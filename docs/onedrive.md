# OneDrive (Word Online)

Integration with a **personal Microsoft account** OneDrive: Thinkflow creates a **new** `.docx`
per test case in a folder you choose and returns the link to open it in Word Online. It **never
overwrites** existing files (the Graph API replaces the whole file and would discard colleagues'
edits): if the name exists it creates `name (2).docx`, `name (3).docx` and so on.

Only personal Microsoft accounts are supported (authority `consumers`).

- Sign-in uses the Microsoft identity platform (authorization code flow with PKCE); the callback is
  on the server: `GET /api/integrations/onedrive/callback`.
- Delegated permissions: `Files.ReadWrite offline_access User.Read`. Tokens are stored encrypted
  (AES-256-GCM, the same `SecretBox` as other credentials) in the `onedrive_account` table and are
  refreshed automatically; if authorization is revoked, Settings shows **Reconnect**.
- Files under 4 MB use `PUT /me/drive/items/{folder}:/{name}:/content` with
  `conflictBehavior=fail`; larger files use an upload session in 10 MiB fragments (multiples of
  320 KiB).
- Default file name: `CT {ticketId} - {title}.docx` (characters `\ / : * ? " < > |` become `-`),
  configurable under Settings, OneDrive.

## Register the application (once)

The same steps appear in Settings, OneDrive. No admin consent or paid Azure subscription is needed.

1. Sign in at <https://entra.microsoft.com> (or portal.azure.com) with a Microsoft account.
2. **Entra ID, App registrations, New registration**; name it, for example, "Thinkflow OneDrive".
3. **Supported account types**: "Personal Microsoft accounts only". "Any directory plus personal
   accounts" also works.
4. **Redirect URI**: platform **Mobile and desktop applications**, with the URI shown in Settings
   (for example `http://localhost:3737/api/integrations/onedrive/callback`). Do not use "Single-page
   application": the server exchanges the code without an `Origin` header and Microsoft refuses it.
   Microsoft accepts `http` only for `localhost` (the port is ignored when comparing); use HTTPS for
   any other host.
5. Copy the **Application (client) ID** from the Overview page into Settings.
6. **Authentication, Advanced settings, Allow public client flows = Yes** (so no secret is needed).
7. **API permissions**: Microsoft Graph, delegated: `Files.ReadWrite`, `offline_access`,
   `User.Read`.
8. In Settings: **Save**, **Connect**, sign in with the OneDrive account and accept.

Alternative with a secret: register the URI on the **Web** platform, create a secret under
_Certificates and secrets_ and paste its **Value** (not the ID) in the secret field; it is stored
encrypted.

Behind a reverse proxy, send `X-Forwarded-Host` and `X-Forwarded-Proto`, or fill in the URI manually
under "Advanced".

## Endpoints

`GET/PUT /api/integrations/onedrive`, `POST .../connect`, `GET .../callback`, `POST .../disconnect`,
`GET .../folders?parentId=`, `PUT .../default-folder` and `POST .../file-name`. The test-case
document uses `POST /api/tests/sessions/:id/ct/onedrive` (see [testing.md](testing.md)).

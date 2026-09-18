# Privacy Policy

YT-LiveRec is a personal-use automation tool. It is not a public service
and has no other users besides its owner.

## What it accesses

The tool uses the YouTube Data API v3, authorized via OAuth, solely to
upload video recordings to the owner's own YouTube channel as private
videos. It requests only the `youtube.upload` scope.

## Data handling

- No data is collected from or shared with any third party.
- No data is sold, rented, or used for advertising.
- Video files are held temporarily (Cloudflare R2 storage) only until
  upload to YouTube completes, then deleted.
- OAuth credentials are stored as encrypted GitHub Actions secrets and
  used only by this repository's own automated workflows.

## Contact

Questions about this tool can be opened as an issue on its
[GitHub repository](https://github.com/Garfiwld/YT-LiveRec).

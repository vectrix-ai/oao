# OAO documentation

This directory is a Mintlify documentation site. Its source of truth is the
current OAO repository and public contracts; examples must not promise endpoints
or attachment behavior that the MVP does not implement.

## Preview

Install the current [Mintlify CLI](https://www.mintlify.com/docs/cli/install):

```sh
npm i -g mint
```

Then run from this directory:

```sh
mint dev
```

The preview opens on `http://localhost:3000` by default. If the OAO API is
already using that port, choose another one:

```sh
mint dev --port 3333
```

Validate frontmatter, navigation, and MDX, then check links and accessibility:

```sh
mint validate
mint broken-links
mint a11y
```

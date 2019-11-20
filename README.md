# mpnp
Nodejs package manager optimized for monorepos

This project is not meant to be production ready but is a proof of concept.

This package manager is optimized for performance in the context of working on a large nodejs-based monorepo.

Benchmark of the various package managers on [a simple monorepo](https://github.com/VincentBailly/TypeScriptMonoRepo/tree/hackathon), the measured scenarios are the three that are the most frequent when working with a monorepo.

|        |  warm cache + clean repo | warm cache + warm repo | adding a new dependency (react) |
| ------ | ------------------------ | ---------------------- | ----------------------- |
| yarn   | 11s                       | 1.2s                   | 3.4s                      |
| pnpm   | 13s                      | 2.2s                   | 5.5s                      |
| mpnp   | 0.4s                     | 0.4s                   | 1.7s                    |


Because this is a proof of concept, many assumptions need to be fullfilled for mpnp to work:
- yarn needs to be installed globally
- nodejs must be version 12
- the repo needs to run with the following environment variables
  NODE_OPTIONS='--preserve-symlinks --preserve-symlinks-main'
- the OS is linux
- all the packages in the monorepos are under the 'packages' folder
- all dependencies are downloaded from npmjs official feed
- each peer dependency is fullfilled by only one version across the repo.
- bin scripts should be javascript code


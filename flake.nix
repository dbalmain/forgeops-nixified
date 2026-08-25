{
  description = "One-command local Ping Identity Platform (ForgeOps) stack";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    forgeops-src = {
      url = "github:ForgeRock/forgeops/identity-platform-2026.3.0";
      flake = false;
    };
  };

  outputs = { self, nixpkgs, forgeops-src }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system:
        f { inherit system; pkgs = nixpkgs.legacyPackages.${system}; });
    in
    {
      packages = forAllSystems ({ pkgs, ... }:
        let
          # Everything `fo` shells out to. Pinned here so a developer's own
          # kubectl/helm cannot change the behaviour of the stack.
          runtimeTools = with pkgs; [
            nodejs_24
            k3d
            kubectl
            kubernetes-helm
            kustomize
            stern
            tilt
            jq
            docker-client
            # `fo config` shells out to both: tar to move config trees in and
            # out of pods and images, diff to render `fo config diff`. Pinning
            # them keeps the output identical to what CI sees.
            gnutar
            diffutils
          ];

          # The platform TypeScript's dependencies, built by nix straight from
          # the committed package-lock.json. This is what makes the "nix and a
          # Docker daemon" claim honest: `npm install` never runs on a
          # developer machine, and the dependency set is pinned by the lock
          # rather than by whatever the registry serves today.
          nodeModules = pkgs.importNpmLock.buildNodeModules {
            npmRoot = ./platform/typescript;
            nodejs = pkgs.nodejs_24;
          };

          fo = pkgs.writeShellApplication {
            name = "fo";
            runtimeInputs = runtimeTools;
            text = ''
              # The pinned upstream ForgeOps tree: Helm chart, config-profile
              # Dockerfiles, and (later) the upstream CLI escape hatch.
              export FO_FORGEOPS_SRC="${forgeops-src}"

              # Where the platform TypeScript's node_modules lives. `fo build`
              # links this into platform/typescript/ rather than copying, so
              # the store stays the single source of truth.
              export FO_NODE_MODULES="${nodeModules}/node_modules"

              # FO_ROOT is the tree `fo` reads its own source and fo.config.ts
              # from. The devShell points it at $PWD so edits take effect with
              # no rebuild; `nix run` falls back to the pinned store copy.
              export FO_ROOT="''${FO_ROOT:-${self}}"

              exec node "$FO_ROOT/tools/fo/main.ts" "$@"
            '';
          };
        in
        {
          inherit fo nodeModules;
          default = fo;
        });

      apps = forAllSystems ({ system, ... }: {
        default = {
          type = "app";
          program = "${self.packages.${system}.fo}/bin/fo";
        };
      });

      devShells = forAllSystems ({ pkgs, system, ... }: {
        default = pkgs.mkShell {
          packages = [ self.packages.${system}.fo ] ++ (with pkgs; [
            # `npm` is here to READ the lockfile and run scripts, never to
            # install: the dependency tree comes from nix. `fo build` fails
            # loudly if node_modules is not the store symlink.
            nodejs_24
            k3d
            kubectl
            kubernetes-helm
            stern
            tilt
            jq
          ]);

          shellHook = ''
            # Run `fo` from the working tree, not the store copy, so editing
            # tools/fo/*.ts takes effect immediately.
            FO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
            export FO_ROOT

            # ESM resolution ignores NODE_PATH, so the platform TypeScript
            # needs a real node_modules NEXT TO its sources. Link the
            # nix-built one rather than copying, so it stays read-only and
            # obviously store-owned.
            export FO_NODE_MODULES="${self.packages.${system}.nodeModules}/node_modules"
            if [ -d "$FO_ROOT/platform/typescript" ]; then
              ln -sfn "$FO_NODE_MODULES" "$FO_ROOT/platform/typescript/node_modules"
            fi

            # Optional rename: `export FO_ALIAS=fops` in .envrc gives you
            # `fops` alongside `fo`. A symlink rather than a shell alias,
            # because direnv exports environment, not shell functions.
            if [ -n "''${FO_ALIAS:-}" ]; then
              mkdir -p "$FO_ROOT/.fo/bin"
              ln -sf "$(command -v fo)" "$FO_ROOT/.fo/bin/$FO_ALIAS"
              PATH="$FO_ROOT/.fo/bin:$PATH"
              export PATH
            fi

            echo "forgeops-nixified dev shell — try: fo doctor"
          '';
        };
      });
    };
}

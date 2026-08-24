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
            jq
            docker-client
          ];

          fo = pkgs.writeShellApplication {
            name = "fo";
            runtimeInputs = runtimeTools;
            text = ''
              # The pinned upstream ForgeOps tree: Helm chart, config-profile
              # Dockerfiles, and (later) the upstream CLI escape hatch.
              export FO_FORGEOPS_SRC="${forgeops-src}"

              # FO_ROOT is the tree `fo` reads its own source and fo.config.ts
              # from. The devShell points it at $PWD so edits take effect with
              # no rebuild; `nix run` falls back to the pinned store copy.
              export FO_ROOT="''${FO_ROOT:-${self}}"

              exec node "$FO_ROOT/tools/fo/main.ts" "$@"
            '';
          };
        in
        {
          inherit fo;
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
            nodejs_24
            k3d
            kubectl
            kubernetes-helm
            stern
            jq
          ]);

          shellHook = ''
            # Run `fo` from the working tree, not the store copy, so editing
            # tools/fo/*.ts takes effect immediately.
            FO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
            export FO_ROOT

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

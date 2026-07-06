{
  description = "pi-searxng — local SearXNG-backed web search tools for pi";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs =
    { self, nixpkgs }:
    let
      # Supported systems. Add more if needed.
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;

      # The extension is pure TypeScript loaded by pi via jiti at runtime —
      # there is no compile/build step. The "package" output just stages the
      # source so a NixOS module (or flake input) can point pi at it.
      version = "0.2.0";
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.stdenv.mkDerivation {
            pname = "pi-searxng";
            inherit version;
            src = ./.;

            dontConfigure = true;
            dontBuild = true;

            installPhase = ''
              runHook preInstall
              mkdir -p $out/lib/pi-searxng
              cp -r ./src ./package.json ./README.md ./LICENSE $out/lib/pi-searxng/
              runHook postInstall
            '';

            meta = with pkgs.lib; {
              description = "Local SearXNG-backed web search tools for pi";
              homepage = "https://github.com/tofusoul/Pi-SearXNG";
              license = licenses.mit;
              platforms = platforms.unix;
            };
          };
        }
      );

      devShells = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              nodejs
              git
            ];
            shellHook = ''
              echo ""
              echo "🐚 pi-searxng dev shell — node $(node --version)"
              echo "   first time:  npm install"
              echo "   type-check:  npm run typecheck"
              echo ""
            '';
          };
        }
      );
    };
}

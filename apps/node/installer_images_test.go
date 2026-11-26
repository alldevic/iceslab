package main

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// The panel installer pulls the base images before it builds, so the build does
// not compete with itself for bandwidth. A tag that is pulled and never built
// from is a dead download; a tag the build needs and the pull misses is the
// download it was meant to take off the build. Both ways, against what
// docker-compose.prod.yml (the only file the installer builds and runs) and the
// two Dockerfiles it builds actually use.
//
// ⚠ Reads files outside the package: `go test -count=1` locally.

var (
	dockerPull    = regexp.MustCompile(`(?m)^docker pull (\S+)`)
	composeImage  = regexp.MustCompile(`(?m)^\s+image:\s*(\S+)`)
	composeDocker = regexp.MustCompile(`(?m)^\s+dockerfile:\s*(\S+)`)
	dockerArg     = regexp.MustCompile(`(?m)^ARG (\w+)=(\S+)`)
	dockerFrom    = regexp.MustCompile(`(?m)^FROM (\S+)`)
)

// imageSets returns the tags the installer pulls and the tags the compose file
// and its Dockerfiles use, read from the given file contents.
func imageSets(t *testing.T, installer, compose string, read func(path string) string) (pulled, used map[string]bool) {
	t.Helper()
	pulled, used = map[string]bool{}, map[string]bool{}
	for _, m := range dockerPull.FindAllStringSubmatch(installer, -1) {
		pulled[m[1]] = true
	}
	for _, m := range composeImage.FindAllStringSubmatch(compose, -1) {
		// Images the build produces (iceslab-backend:latest) are not pulled.
		if !strings.HasPrefix(m[1], "iceslab-") {
			used[m[1]] = true
		}
	}
	files := composeDocker.FindAllStringSubmatch(compose, -1)
	if len(files) < 2 {
		t.Fatalf("expected the compose file to build at least two Dockerfiles, found %d", len(files))
	}
	for _, f := range files {
		d := read(f[1])
		args := map[string]string{}
		for _, a := range dockerArg.FindAllStringSubmatch(d, -1) {
			args[a[1]] = a[2]
		}
		for _, m := range dockerFrom.FindAllStringSubmatch(d, -1) {
			img := regexp.MustCompile(`\$\{(\w+)\}`).ReplaceAllStringFunc(m[1], func(v string) string {
				return args[v[2:len(v)-1]]
			})
			if strings.Contains(img, "$") || strings.HasSuffix(img, ":") {
				t.Fatalf("%s: FROM %s does not resolve to a tag from the ARG defaults", f[1], m[1])
			}
			used[img] = true
		}
	}
	return pulled, used
}

func imageDiff(pulled, used map[string]bool) (problems []string) {
	for tag := range pulled {
		if !used[tag] {
			problems = append(problems, "pulled and never built from or run: "+tag)
		}
	}
	for tag := range used {
		if !pulled[tag] {
			problems = append(problems, "used by the build and not pulled: "+tag)
		}
	}
	sort.Strings(problems)
	return problems
}

func readImageSources(t *testing.T) (installer, compose string, read func(string) string) {
	t.Helper()
	b, err := os.ReadFile("../../scripts/install-iceslab.sh")
	if err != nil {
		t.Fatal(err)
	}
	c, err := os.ReadFile("../../docker-compose.prod.yml")
	if err != nil {
		t.Fatal(err)
	}
	return string(b), string(c), func(path string) string {
		d, err := os.ReadFile(filepath.Join("../..", path))
		if err != nil {
			t.Fatal(err)
		}
		return string(d)
	}
}

func TestThePulledImagesAreTheOnesTheBuildUses(t *testing.T) {
	installer, compose, read := readImageSources(t)
	pulled, used := imageSets(t, installer, compose, read)
	// Control: a parse that finds nothing agrees with itself.
	if len(pulled) < 4 || len(used) < 4 {
		t.Fatalf("expected at least 4 images each side, pulled %v used %v", pulled, used)
	}
	for _, p := range imageDiff(pulled, used) {
		t.Error(p)
	}
}

// The check has teeth: change one tag in a copy, each place in turn, and it
// names the tag that went missing and the one that appeared.
func TestTheImageCheckFailsOnAnyTagThatDrifts(t *testing.T) {
	installer, compose, read := readImageSources(t)
	if p, u := imageSets(t, installer, compose, read); len(imageDiff(p, u)) != 0 {
		t.Skip("the tree is already inconsistent: see TestThePulledImagesAreTheOnesTheBuildUses")
	}
	// A pulled tag drifts.
	p, u := imageSets(t, strings.Replace(installer, "docker pull nginx:1.27-alpine", "docker pull nginx:1.28-alpine", 1), compose, read)
	if d := strings.Join(imageDiff(p, u), "\n"); !strings.Contains(d, "nginx:1.28-alpine") || !strings.Contains(d, "not pulled: nginx:1.27-alpine") {
		t.Errorf("a pull drifted: %q", d)
	}
	// A compose image drifts.
	p, u = imageSets(t, installer, strings.Replace(compose, "image: redis:7-alpine", "image: redis:8-alpine", 1), read)
	if d := strings.Join(imageDiff(p, u), "\n"); !strings.Contains(d, "redis:7-alpine") || !strings.Contains(d, "redis:8-alpine") {
		t.Errorf("a compose image drifted: %q", d)
	}
	// A Dockerfile ARG drifts.
	p, u = imageSets(t, installer, compose, func(path string) string {
		return strings.Replace(read(path), "ARG NODE_VERSION=22.22-alpine", "ARG NODE_VERSION=22.23-alpine", 1)
	})
	if d := strings.Join(imageDiff(p, u), "\n"); !strings.Contains(d, "node:22.23-alpine") || !strings.Contains(d, "node:22.22-alpine") {
		t.Errorf("an ARG drifted: %q", d)
	}
	// A pull with no build behind it (the golang one the base once had).
	p, u = imageSets(t, installer+"\ndocker pull golang:1.22-alpine >/dev/null 2>&1 &\n", compose, read)
	if d := strings.Join(imageDiff(p, u), "\n"); !strings.Contains(d, "golang:1.22-alpine") {
		t.Errorf("a dead pull: %q", d)
	}
}

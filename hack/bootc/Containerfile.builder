FROM registry.fedoraproject.org/fedora:43

RUN --mount=type=cache,target=/var/cache/libdnf5 \
    dnf install -y \
    git make rpm-build rsync \
    nodejs npm \
    gettext libappstream-glib systemd-rpm-macros

WORKDIR /build

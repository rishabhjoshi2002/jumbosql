package xdocker

import "context"

type InstanceID string
type ManageClusterConfig struct {
	Image     string // pg_mantra: another image than the deployment one (Upgrades runner); empty = default
	Envs      []string
	ExtraVars string // JSON string
	Mounts    []Mount
}

type Mount struct {
	DockerPath string
	HostPath   string
}

type IManager interface {
	ManageCluster(ctx context.Context, req *ManageClusterConfig) (InstanceID, error)
	GetStatus(ctx context.Context, id InstanceID) (string, error)
	StoreContainerLogs(ctx context.Context, id InstanceID, store func(logMessage string))
	PreloadImage(ctx context.Context)
	RemoveContainer(ctx context.Context, id InstanceID) error
}

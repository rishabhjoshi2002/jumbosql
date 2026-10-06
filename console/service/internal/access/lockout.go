package access

import (
	"errors"
	"time"

	"postgresql-cluster-console/internal/policy"
	"postgresql-cluster-console/internal/storage"
)

var ErrLockout = errors.New("after this change no user could manage users and policies any more; keep at least one user with users.manage and policies.manage")

// WouldLockOut: with these policies and users, could nobody manage users and policies? IP / time conditions of
// allow policies are ignored on purpose: someone must be able to, from somewhere, at some time.
func WouldLockOut(policies []policy.Policy, users []storage.User) bool {
	set := &policy.Set{}
	for _, p := range policies {
		c := p
		if c.Effect == "allow" {
			c.Conditions = policy.Conditions{}
		}
		set.Policies = append(set.Policies, c)
	}
	ctx := policy.Context{Now: time.Now()}
	for _, u := range users {
		sub := policy.Subject{UserID: u.ID, Username: u.Username, Attributes: u.Attributes}
		if set.Allowed(sub, policy.PoliciesManage, nil, "", ctx).Allowed && set.Allowed(sub, policy.UsersManage, nil, "", ctx).Allowed {
			return false
		}
	}
	return true
}

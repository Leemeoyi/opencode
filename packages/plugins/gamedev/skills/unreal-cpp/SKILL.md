---
name: unreal-cpp
description: Use when writing or fixing Unreal Engine C++ - UCLASS/UPROPERTY/UFUNCTION reflection, object lifetime and garbage collection, Blueprint exposure, modules and .Build.cs, Gameplay Ability System, replication, and reading Unreal Build Tool errors.
---

# Unreal Engine C++

## Build, then verify

1. `game_build` after every C++ change. Fix errors top-down: the first error often causes the rest.
2. `game_playtest` on the relevant map to catch crashes, failed `check`/`ensure` and runtime errors.
3. `game_test` when the project has automation tests for the area you changed.

Reading build errors:

- `C2065`/`C3861` (undeclared identifier): missing `#include`, or the symbol lives in a module not listed in `.Build.cs`.
- `LNK2019`/`LNK2001` (unresolved external): add the module to `PublicDependencyModuleNames` or `PrivateDependencyModuleNames`, or export the class with the module's `_API` macro.
- `generated.h` errors: the `#include "X.generated.h"` line must be the last include in the header, and the file name must match.
- "Unable to build while Live Coding is active": the editor is open. Use Live Coding through the editor, or ask before closing it.

## Reflection

- Every `UCLASS`, `USTRUCT` and `UENUM` needs `GENERATED_BODY()` and its `.generated.h` include.
- Mark `UObject*` members `UPROPERTY()` (or use `TObjectPtr<>` with `UPROPERTY()`). A raw pointer the garbage collector cannot see may be freed under you.
- Exposure: `EditAnywhere` for designer-tunable defaults and instances, `EditDefaultsOnly` for class defaults only, `VisibleAnywhere` for components, `BlueprintReadOnly`/`BlueprintReadWrite` for graph access. Add `Category` so the value is findable.
- `UFUNCTION(BlueprintCallable)` for actions, `BlueprintPure` for side-effect-free getters, `BlueprintImplementableEvent`/`BlueprintNativeEvent` for hooks Blueprints override.
- Changing a reflected header (new `UPROPERTY`, `UFUNCTION`, changed class layout) is not safe for Live Coding; a full build with the editor closed is safer.

## Object lifetime

- Create components in the constructor with `CreateDefaultSubobject`; spawn actors with `GetWorld()->SpawnActor`. Never `new` a `UObject`.
- Use `TWeakObjectPtr` for references you do not own, and check `IsValid()` before use. Destroyed actors stay in memory until garbage collection.
- Bind delegates in `BeginPlay`, unbind in `EndPlay`. Timers set with `GetWorldTimerManager()` need clearing when the owner goes away.

## Gameplay

- Scale per-frame movement by `DeltaSeconds`. Turn off `PrimaryActorTick.bCanEverTick` for actors that do not need `Tick`, and prefer timers and events.
- Tunable gameplay values belong in `UPROPERTY(EditDefaultsOnly)` members or data assets, not hard-coded in `.cpp` files.
- Gameplay Ability System: attributes live in an `UAttributeSet` with `ATTRIBUTE_ACCESSORS`; clamp in `PreAttributeChange` and `PostGameplayEffectExecute`. Grant abilities on the server.
- Replication: mark replicated members `UPROPERTY(Replicated)` or `ReplicatedUsing=OnRep_X`, register them in `GetLifetimeReplicatedProps`, and change them only on the server (`HasAuthority()`).

## Modules

- New dependencies go in `<Module>.Build.cs`. Prefer private dependencies unless a public header needs the other module's types.
- Editor-only code goes in an editor module or inside `#if WITH_EDITOR`, or packaged builds fail.

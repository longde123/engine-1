pc.extend(pc, function () {

    var maxSize = 2048;
    var maskDynamic = 1;
    var maskBaked = 2;
    var maskLightmap = 4;

    var sceneLightmaps = [];
    var lmCamera;
    var tempVec = new pc.Vec3();
    var bounds = new pc.BoundingBox();

    function collectModels(node, nodes, allNodes) {
        if (!node.enabled) return;

        if (node.model && node.model.model) {
            allNodes.push(node);
            if (node.model.data.lightmapped) {
                nodes.push(node);
            }
        }
        var children = node.getChildren();
        for(var i=0; i<children.length; i++) {
            collectModels(children[i], nodes, allNodes);
        }
    }

    var Lightmapper = function (device, root, scene, renderer, assets) {
        this.device = device;
        this.root = root;
        this.scene = scene;
        this.renderer = renderer;
        this.assets = assets;
    };

    Lightmapper.prototype = {
        bake: function() {
            var i;
            var device = this.device;
            var scene = this.scene;

            // Delete old lightmaps, if present
            for(i=0; i<sceneLightmaps.length; i++) {
                sceneLightmaps[i].destroy();
            }
            sceneLightmaps = [];

            // Collect bakeable models
            var nodes = [];
            var allNodes = [];
            collectModels(this.root, nodes, allNodes);

            // Calculate lightmap sizes and allocate textures
            var texSize = [];
            var lmaps = [];
            var area, size;
            var sizeMult = scene.lightmapSizeMultiplier || 1;
            var scale = new pc.Vec3();
            var parent;
            var tex;
            var instances;
            var _area;
            for(i=0; i<nodes.length; i++) {
                area = {x:1, y:1, z:1};
                if (nodes[i].model.asset) {
                    _area = this.assets.get(nodes[i].model.asset).data.area || area;
                    area.x = _area.x;
                    area.y = _area.y;
                    area.z = _area.z;
                } else if (nodes[i].model._area) {
                    _area = nodes[i].model._area;
                    area.x = _area.x;
                    area.y = _area.y;
                    area.z = _area.z;
                }
                var areaMult = nodes[i].model.lightmapSizeMultiplier || 1;
                area.x *= areaMult;
                area.y *= areaMult;
                area.z *= areaMult;

                scale.copy(nodes[i].getLocalScale());
                parent = nodes[i].getParent();
                while(parent) {
                    scale.mul(parent.getLocalScale());
                    parent = parent.getParent();
                }

                size = Math.min(pc.math.nextPowerOfTwo((area.x*scale.x + area.y*scale.y + area.z*scale.z) * sizeMult), maxSize);
                texSize.push(size);

                tex = new pc.Texture(device, {width:size,
                                              height:size,
                                              format:pc.PIXELFORMAT_R8_G8_B8_A8,
                                              autoMipmap:false,
                                              rgbm:true});
                tex.addressU = pc.ADDRESS_CLAMP_TO_EDGE;
                tex.addressV = pc.ADDRESS_CLAMP_TO_EDGE;
                tex._minFilter = pc.FILTER_LINEAR;
                tex._magFilter = pc.FILTER_LINEAR;
                lmaps.push(tex);
            }

            // Collect bakeable lights
            var lights = [];
            var origMask = [];
            var origShadowMode = [];
            var origEnabled = [];
            var sceneLights = scene._lights;
            var mask;
            for(i=0; i<sceneLights.length; i++) {
                if (sceneLights[i]._enabled) {
                    mask = sceneLights[i].mask;
                    if ((mask & maskLightmap) !==0) {
                        origMask.push(mask);
                        origShadowMode.push(sceneLights[i].shadowUpdateMode);
                        sceneLights[i].setMask(0xFFFFFFFF);
                        sceneLights[i].shadowUpdateMode =
                            sceneLights[i].getType()===pc.LIGHTTYPE_DIRECTIONAL? pc.SHADOWUPDATE_REALTIME : pc.SHADOWUPDATE_THISFRAME;
                        lights.push(sceneLights[i]);
                    }
                }
                origEnabled.push(sceneLights[i]._enabled);
                sceneLights[i].setEnabled(false);
            }

            // Init shaders
            var chunks = pc.shaderChunks;
            var xformUv1 = chunks.transformUv1VS;
            var bakeLmEnd = chunks.bakeLmEndPS;
            var dilate = chunks.dilatePS;

            var dilateShader = chunks.createShaderFromCode(device, chunks.fullscreenQuadVS, dilate, "lmDilate");
            var constantTexSource = device.scope.resolve("source");
            var constantPixelOffset = device.scope.resolve("pixelOffset");
            var i, j;

            var lms = {};
            var lm, m, mat;
            var drawCalls = scene.drawCalls;

            // update scene matrices
            for(i=0; i<drawCalls.length; i++) {
                if (drawCalls[i].node) drawCalls[i].node.getWorldTransform();
            }

            // Store scene values
            var origFog = scene.fog;
            var origDrawCalls = scene.drawCalls;

            scene.fog = pc.FOG_NONE;

            // Create pseudo-camera
            if (!lmCamera) {
                lmCamera = new pc.Camera();
                lmCamera._node = new pc.GraphNode();
                lmCamera.setClearOptions({color:null, depth:1, flags:0});
            }

            var node;
            var lm, rcv, mat;

            // Disable existing scene lightmaps
            for(node=0; node<allNodes.length; node++) {
                rcv = allNodes[node].model.model.meshInstances;
                for(i=0; i<rcv.length; i++) {
                    rcv[i]._shaderDefs &= ~pc.SHADERDEF_LM;
                    rcv[i].mask |= pc.MASK_DYNAMIC;
                    rcv[i].mask &= ~pc.MASK_LIGHTMAP;
                }
            }

            // Change shadow casting
            var origCastShadows = [];
            for(node=0; node<allNodes.length; node++) {
                origCastShadows[node] = allNodes[node].model.castShadows;
                allNodes[node].model.castShadows = allNodes[node].model.data.castShadowsLightmap;
            }

            var origXform = [];
            var origEnd = [];
            var origAlpha = [];
            var origAlphaOpaque = [];
            var origAlphaPremul = [];
            var origCull = [];
            var origForceUv1 = [];

            // Render lightmaps
            for(node=0; node<nodes.length; node++) {
                lm = lmaps[node];
                rcv = nodes[node].model.model.meshInstances;
                scene.drawCalls = [];

                // Calculate model AABB
                if (rcv.length > 0) {
                    bounds.copy(rcv[0].aabb);
                    for(i=0; i<rcv.length; i++) {
                        rcv[i].node.getWorldTransform();
                        bounds.add(rcv[i].aabb);
                    }
                }

                // Store original material values to be changed
                for(i=0; i<rcv.length; i++) {
                    mat = rcv[i].material;
                    origXform.push(mat.chunks.transformVS);
                    origEnd.push(mat.chunks.endPS);
                    origAlpha.push(mat.chunks.outputAlphaPS);
                    origAlphaOpaque.push(mat.chunks.outputAlphaOpaquePS);
                    origAlphaPremul.push(mat.chunks.outputAlphaPremulPS);
                    origCull.push(mat.cull);
                    origForceUv1.push(mat.forceUv1);
                }

                for(i=0; i<rcv.length; i++) {
                    // patch meshInstance
                    m = rcv[i];
                    m._shaderDefs &= ~pc.SHADERDEF_LM; // disable LM define, if set, to get bare ambient on first pass
                    m.mask = maskLightmap; // only affected by LM lights

                    // patch material
                    mat = m.material;
                    mat.chunks.transformVS = xformUv1; // draw UV1
                    mat.chunks.endPS = bakeLmEnd; // encode to RGBM

                    // avoid writing unrelated things to alpha
                    mat.chunks.outputAlphaPS = "\n";
                    mat.chunks.outputAlphaOpaquePS = "\n";
                    mat.chunks.outputAlphaPremulPS = "\n";
                    mat.cull = pc.CULLFACE_NONE;
                    mat.forceUv1 = true; // provide data to xformUv1
                    mat.update();

                    scene.drawCalls.push(m);
                }

                var targ = new pc.RenderTarget(device, lm, {
                    depth: false
                });

                // Create 2nd LM for ping-pong
                var texTmp = new pc.Texture(device, {width:lm.width,
                                                  height:lm.height,
                                                  format:lm.format,
                                                  autoMipmap:false,
                                                  rgbm:true});
                texTmp.addressU = lm.addressU;
                texTmp.addressV = lm.addressV;
                texTmp._minFilter = pc.FILTER_LINEAR;
                texTmp._magFilter = pc.FILTER_LINEAR;
                var targTmp = new pc.RenderTarget(device, texTmp, {
                    depth: false
                });

                // Disable all bakeable lights
                for(j=0; j<lights.length; j++) {
                    lights[j].setEnabled(false);
                }

                // Accumulate lights into RGBM texture
                var curTarg;
                for(i=0; i<lights.length; i++) {
                    lights[i].setEnabled(true); // enable next light

                    // Tweak camera to fully see the model, so directional light frustum will also see it
                    if (lights[i].getType()===pc.LIGHTTYPE_DIRECTIONAL) {
                        tempVec.copy(bounds.center);
                        tempVec.y += bounds.halfExtents.y;

                        lmCamera._node.setPosition(tempVec);
                        lmCamera._node.setEulerAngles(-90, 0, 0);

                        var frustumSize = Math.max(bounds.halfExtents.x, bounds.halfExtents.z);

                        lmCamera.setProjection( pc.PROJECTION_ORTHOGRAPHIC );
                        lmCamera.setNearClip( 0 );
                        lmCamera.setFarClip( bounds.halfExtents.y * 2 );
                        lmCamera.setAspectRatio( 1 );
                        lmCamera.setOrthoHeight( frustumSize );
                    }

                    // ping-ponging output
                    curTarg = i%2===0? targ : targTmp;
                    lmCamera.setRenderTarget(curTarg);

                    //console.log("Baking light "+lights[i]._node.name + " on model " + nodes[node].name);
                    this.renderer.render(scene, lmCamera);

                    for(j=0; j<rcv.length; j++) {
                        m = rcv[j];
                        m.setParameter("texture_lightMap", i%2===0? lm : texTmp); // ping-ponging input
                        m._shaderDefs |= pc.SHADERDEF_LM; // force using LM even if material doesn't have it
                    }

                    lights[i].setEnabled(false); // disable that light
                }

                if (curTarg!==targ) {
                    var tmp = targTmp;
                    targTmp = targ;
                    targ = tmp;

                    tmp = texTmp;
                    texTmp = lm;
                    lm = tmp;
                }

                // Dilate
                var numDilates2x = 4; // 8 dilates
                var pixelOffset = new pc.Vec2(1/lm.width, 1/lm.height);
                constantPixelOffset.setValue(pixelOffset.data);
                for(i=0; i<numDilates2x; i++) {
                    constantTexSource.setValue(lm);
                    pc.drawQuadWithShader(device, targTmp, dilateShader);

                    constantTexSource.setValue(texTmp);
                    pc.drawQuadWithShader(device, targ, dilateShader);
                }

                for(i=0; i<rcv.length; i++) {
                    m = rcv[i];
                    m.mask = maskBaked;

                    // roll material back
                    mat = m.material;
                    mat.chunks.transformVS = origXform[i];
                    mat.chunks.endPS = origEnd[i];
                    mat.chunks.outputAlphaPS = origAlpha[i];
                    mat.chunks.outputAlphaOpaquePS = origAlphaOpaque[i];
                    mat.chunks.outputAlphaPremulPS = origAlphaPremul[i];
                    mat.cull = origCull[i];
                    mat.forceUv1 = origForceUv1[i];
                    mat.update();

                    // Set lightmap
                    rcv[i].setParameter("texture_lightMap", lm);
                }

                sceneLightmaps.push(lm);

                // Clean up
                targ.destroy();
                targTmp.destroy();
                texTmp.destroy();
            }

            // Revert shadow casting
            for(node=0; node<allNodes.length; node++) {
                allNodes[node].model.castShadows = origCastShadows[node];
            }

            // Enable all lights back
            for(i=0; i<lights.length; i++) {
                lights[i].setMask(origMask[i]);
                lights[i].shadowUpdateMode = origShadowMode[i];
            }

            for(i=0; i<sceneLights.length; i++) {
                sceneLights[i].setEnabled(origEnabled[i]);
            }

            // Roll back scene stuff
            scene.drawCalls = origDrawCalls;
            scene.fog = origFog;
        }
    };

    return {
        Lightmapper: Lightmapper,
        MASK_DYNAMIC: maskDynamic,
        MASK_BAKED: maskBaked,
        MASK_LIGHTMAP: maskLightmap
    };
}());
